import express from "express";
import puppeteer from "puppeteer";
import { existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const app = express();

// Helper function to replace deprecated waitForTimeout
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// Cache for Chrome path to avoid repeated checks
let cachedChromePath = null;
let chromeInstallAttempted = false;

// Ensure cache directory exists
function ensureCacheDir() {
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || "/tmp/.cache/puppeteer";
  try {
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
      console.log("Created cache directory:", cacheDir);
    }
  } catch (e) {
    console.warn("Could not create cache directory:", e.message);
  }
}

// Ensure Chrome is installed (for Render deployment)
// This runs once at startup, not on every request
async function ensureChromeInstalled() {
  // Ensure cache directory exists
  ensureCacheDir();
  
  // Return cached path if available
  if (cachedChromePath && existsSync(cachedChromePath)) {
    return cachedChromePath;
  }
  
  try {
    const chromePath = puppeteer.executablePath();
    if (chromePath && existsSync(chromePath)) {
      console.log("Chrome found at:", chromePath);
      cachedChromePath = chromePath;
      return chromePath;
    }
    
    // Chrome not found, try to install it (only once)
    if (!chromeInstallAttempted) {
      chromeInstallAttempted = true;
      console.log("Chrome not found, attempting to install...");
      console.log("Cache directory:", process.env.PUPPETEER_CACHE_DIR || "default");
      try {
        execSync("npx puppeteer browsers install chrome", { 
          stdio: "inherit",
          timeout: 300000, // 5 minutes timeout
          env: { ...process.env }
        });
        console.log("Chrome installation command completed");
        
        // Wait a moment for file system to sync
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Try to get path again
        const newChromePath = puppeteer.executablePath();
        if (newChromePath && existsSync(newChromePath)) {
          console.log("Chrome installed at:", newChromePath);
          cachedChromePath = newChromePath;
          return newChromePath;
        } else {
          console.error("Chrome installation completed but path not found:", newChromePath);
        }
      } catch (installError) {
        console.error("Failed to install Chrome:", installError.message);
        // Don't throw, let Puppeteer try to handle it
      }
    }
    
    return null;
  } catch (e) {
    console.error("Error ensuring Chrome installation:", e.message);
    return null;
  }
}

// Initialize Chrome check at startup (non-blocking)
ensureChromeInstalled().catch(err => {
  console.error("Startup Chrome check failed:", err.message);
});

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
          await delay(500); // Wait for expansion
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
        await delay(300);
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

    await delay(2000); // Wait for lazy loading

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
    // Ensure Chrome is installed (will install if not found)
    const chromePath = await ensureChromeInstalled();
    
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

    // Use the Chrome path if we found/installed it
    if (chromePath) {
      launchOptions.executablePath = chromePath;
    }

    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();
    
    // Enhanced anti-detection measures
    // Set realistic user agent (updated to recent Chrome version)
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Set additional headers to appear more like a real browser
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Cache-Control': 'max-age=0'
    });

    // Remove webdriver property to avoid detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    // Override permissions to avoid permission prompts (do this after navigation)
    // We'll set this after successful navigation

    // Handle request failures and retries
    let navigationSuccess = false;
    let lastError = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Navigation attempt ${attempt}/${maxRetries} to: ${url}`);
        
        // Navigate to URL with better error handling
        const response = await page.goto(url, { 
          waitUntil: "domcontentloaded", // Changed from networkidle2 to be more lenient
          timeout: 90000 // Increased timeout
        });
        
        // Wait a bit for page to stabilize
        await delay(2000);

        // Check if navigation was successful
        if (response && response.status() < 400) {
          navigationSuccess = true;
          console.log(`Navigation successful with status: ${response.status()}`);
          break;
        } else if (response) {
          console.warn(`Navigation returned status: ${response.status()}`);
          // Continue anyway, sometimes Google returns non-200 but page still loads
          navigationSuccess = true;
          break;
        }
      } catch (navError) {
        lastError = navError;
        console.error(`Navigation attempt ${attempt} failed:`, navError.message);
        
        // If it's a network error, wait before retrying
        if (attempt < maxRetries && (navError.message.includes('ERR_ABORTED') || navError.message.includes('net::'))) {
          const waitTime = attempt * 2000; // Exponential backoff: 2s, 4s, 6s
          console.log(`Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          // Try to close and recreate the page
          try {
            await page.close();
            page = await browser.newPage();
            await page.setUserAgent(
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            );
            await page.setViewport({ width: 1920, height: 1080 });
            await page.setExtraHTTPHeaders({
              'Accept-Language': 'en-US,en;q=0.9',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            });
            await page.evaluateOnNewDocument(() => {
              Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
              });
            });
          } catch (pageError) {
            console.error("Error recreating page:", pageError.message);
          }
        } else {
          break;
        }
      }
    }

    if (!navigationSuccess) {
      throw new Error(
        `Failed to navigate to URL after ${maxRetries} attempts. ` +
        `Last error: ${lastError?.message || 'Unknown error'}. ` +
        `This might be due to Google blocking automated requests or network issues.`
      );
    }

    // Wait a bit for page to fully load
    await delay(3000);

    // Verify page actually loaded (check for Google Maps content)
    const pageTitle = await page.title();
    const pageUrl = page.url();
    console.log(`Page loaded - Title: ${pageTitle}, URL: ${pageUrl}`);
    
    // Check if we got redirected or blocked
    if (!pageUrl.includes('google.com/maps')) {
      throw new Error(`Page redirected to unexpected URL: ${pageUrl}. Google may have blocked the request.`);
    }

    // Override permissions to avoid permission prompts
    try {
      const context = browser.defaultBrowserContext();
      const urlObj = new URL(url);
      await context.overridePermissions(`https://${urlObj.hostname}/*`, ['geolocation']);
    } catch (permError) {
      console.warn("Could not override permissions:", permError.message);
    }

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
          await delay(2000);
          await page.waitForSelector(".jftiEf, [data-review-id], .MyEned", { 
            timeout: 15000 
          });
        } else {
          // Try data attribute selector
          const reviewsTabByData = await page.$('[data-value="Reviews"]');
          if (reviewsTabByData) {
            await reviewsTabByData.click();
            await delay(2000);
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
