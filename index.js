import express from "express";
import puppeteer from "puppeteer";
import { existsSync } from "fs";

const app = express();

// Enable CORS for frontend access
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Validate Google Maps URL
function isValidGoogleMapsUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes("google.com") && 
           (urlObj.pathname.includes("/maps/place") || urlObj.pathname.includes("/maps/search"));
  } catch {
    return false;
  }
}

// Improved review extraction with multiple selector fallbacks
async function extractReviews(page) {
  return await page.evaluate(() => {
    // Try multiple selector patterns (Google changes these frequently)
    const reviewSelectors = [
      ".jftiEf",           // Primary selector
      "[data-review-id]",  // Alternative
      ".MyEned"            // Another variant
    ];

    let reviewElements = [];
    for (const selector of reviewSelectors) {
      reviewElements = document.querySelectorAll(selector);
      if (reviewElements.length > 0) break;
    }

    if (reviewElements.length === 0) {
      return [];
    }

    return [...reviewElements].map(el => {
      // Try multiple selectors for each field
      const authorSelectors = [".d4r55", ".X43Kjb", "[data-review-id]"];
      const ratingSelectors = [".kvMYJc", ".Fam1ne", "[aria-label*='star']"];
      const textSelectors = [".wiI7pd", ".MyEned", ".review-full-text"];
      const dateSelectors = [".rsqaWe", ".p4vbYd", ".fnsRMc"];

      const findText = (selectors) => {
        for (const sel of selectors) {
          const elem = el.querySelector(sel);
          if (elem) return elem.innerText?.trim() || "";
        }
        return "";
      };

      const findRating = () => {
        for (const sel of ratingSelectors) {
          const elem = el.querySelector(sel);
          if (elem) {
            const ariaLabel = elem.getAttribute("aria-label") || "";
            const match = ariaLabel.match(/(\d+)/);
            if (match) return Number(match[1]);
          }
        }
        // Fallback: look for star emoji or rating text
        const ratingText = el.innerText.match(/(\d+)\s*star/i);
        return ratingText ? Number(ratingText[1]) : null;
      };

      return {
        author: findText(authorSelectors),
        rating: findRating(),
        text: findText(textSelectors),
        date: findText(dateSelectors)
      };
    }).filter(review => review.text || review.author); // Filter out empty reviews
  });
}

// Expand truncated reviews
async function expandReviews(page) {
  try {
    // Look for "More" buttons to expand full review text
    const expandButtons = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      return buttons
        .filter(btn => {
          const text = btn.innerText?.toLowerCase() || '';
          const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
          return text.includes('more') || ariaLabel.includes('more');
        })
        .map(btn => {
          // Return selector for the button
          if (btn.id) return `#${btn.id}`;
          if (btn.className) return `.${btn.className.split(' ')[0]}`;
          return null;
        })
        .filter(Boolean);
    });

    for (const selector of expandButtons) {
      try {
        const button = await page.$(selector);
        if (button) {
          await button.click();
          await page.waitForTimeout(500); // Wait for expansion
        }
      } catch (e) {
        // Button might not be clickable, continue
      }
    }

    // Alternative: try clicking all buttons with "More" text using XPath
    const moreButtons = await page.$x("//button[contains(text(), 'More')]");
    for (const button of moreButtons) {
      try {
        await button.click();
        await page.waitForTimeout(300);
      } catch (e) {
        // Continue if button can't be clicked
      }
    }
  } catch (e) {
    // If expansion fails, continue with truncated reviews
    console.warn("Could not expand all reviews:", e.message);
  }
}

// Improved scrolling to load more reviews
async function scrollToLoadReviews(page, maxScrolls = 10) {
  let previousCount = 0;
  let scrollAttempts = 0;
  let noNewReviewsCount = 0;

  while (scrollAttempts < maxScrolls) {
    // Scroll to bottom of reviews section
    await page.evaluate(() => {
      const reviewsSection = document.querySelector('[role="main"]') || document.body;
      reviewsSection.scrollTop = reviewsSection.scrollHeight;
    });

    await page.waitForTimeout(2000); // Wait for lazy loading

    // Check if new reviews loaded
    const currentCount = await page.evaluate(() => {
      return document.querySelectorAll(".jftiEf, [data-review-id], .MyEned").length;
    });

    if (currentCount === previousCount) {
      noNewReviewsCount++;
      if (noNewReviewsCount >= 2) {
        // No new reviews for 2 consecutive scrolls, stop
        break;
      }
    } else {
      noNewReviewsCount = 0;
      previousCount = currentCount;
    }

    scrollAttempts++;
  }
}

app.get("/scrape", async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ error: "Missing ?url= parameter" });
  }

  if (!isValidGoogleMapsUrl(url)) {
    return res.status(400).json({ error: "Invalid Google Maps URL. Please provide a valid Google Maps place URL." });
  }

  let browser;
  try {
    // Configure Puppeteer for Render deployment
    const launchOptions = {
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding"
      ]
    };

    // On Render, try to find Chrome executable
    // Puppeteer should automatically find Chrome if installed via build command
    try {
      // Try to get the executable path - this will work if Chrome is installed
      const chromePath = puppeteer.executablePath();
      if (chromePath && existsSync(chromePath)) {
        launchOptions.executablePath = chromePath;
        console.log("Found Chrome at:", chromePath);
      } else {
        console.log("Chrome not found at:", chromePath, "- Puppeteer will attempt to download");
      }
    } catch (e) {
      console.log("Chrome path detection failed:", e.message);
    }

    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();
    
    // Set realistic user agent to avoid bot detection
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Navigate to URL
    await page.goto(url, { 
      waitUntil: "networkidle2", 
      timeout: 60000 
    });

    // Wait for reviews to load (try multiple selectors)
    try {
      await page.waitForSelector(".jftiEf, [data-review-id], .MyEned", { 
        timeout: 15000 
      });
    } catch (e) {
      // If reviews don't load, might need to click "Reviews" tab
      try {
        // Try to find Reviews tab using XPath
        const reviewsTabs = await page.$x("//button[contains(text(), 'Reviews')] | //div[contains(text(), 'Reviews')]");
        if (reviewsTabs.length > 0) {
          await reviewsTabs[0].click();
          await page.waitForTimeout(2000);
          await page.waitForSelector(".jftiEf, [data-review-id], .MyEned", { 
            timeout: 15000 
          });
        } else {
          // Try data attribute selector
          const reviewsTabByData = await page.$('[data-value="Reviews"]');
          if (reviewsTabByData) {
            await reviewsTabByData.click();
            await page.waitForTimeout(2000);
            await page.waitForSelector(".jftiEf, [data-review-id], .MyEned", { 
              timeout: 15000 
            });
          }
        }
      } catch (tabError) {
        throw new Error("Could not find reviews section. The page might require login or the URL is incorrect.");
      }
    }

    // Expand truncated reviews
    await expandReviews(page);

    // Scroll to load more reviews
    await scrollToLoadReviews(page, 10);

    // Extract reviews
    const reviews = await extractReviews(page);

    await browser.close();

    if (reviews.length === 0) {
      return res.status(404).json({ 
        error: "No reviews found. The selectors might have changed or the page structure is different." 
      });
    }

    res.json({ 
      success: true, 
      count: reviews.length, 
      reviews,
      url: url
    });

  } catch (err) {
    if (browser) {
      await browser.close().catch(() => {});
    }
    
    console.error("Scraping error:", err);
    res.status(500).json({ 
      error: err.message || "An error occurred while scraping reviews",
      details: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
  }
});

app.get("/", (req, res) => {
  res.send("Google Review Scraper Running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
