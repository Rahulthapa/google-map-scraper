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
      ".MyEned",           // Another variant
      ".fontBodyMedium",   // Newer selector (found in logs)
      "[jsaction*='review']", // JS action based
      ".d4r55"             // Author name can also indicate review container
    ];

    let reviewElements = [];
    let usedSelector = null;
    
    for (const selector of reviewSelectors) {
      reviewElements = document.querySelectorAll(selector);
      if (reviewElements.length > 0) {
        usedSelector = selector;
        console.log(`Using selector: ${selector}, found ${reviewElements.length} elements`);
        break;
      }
    }

    if (reviewElements.length === 0) {
      console.log("No review elements found with any selector");
      return [];
    }

    // If we're using .fontBodyMedium, we need to find parent review containers
    // .fontBodyMedium might be the text itself, so we need to find the review container
    let actualReviewElements = [];
    
    if (usedSelector === ".fontBodyMedium") {
      // .fontBodyMedium is likely the review text, find parent containers
      const fontElements = Array.from(reviewElements);
      const reviewContainers = new Set();
      
      fontElements.forEach(el => {
        // Walk up the DOM to find the review container
        let parent = el.parentElement;
        let depth = 0;
        while (parent && depth < 10) {
          // Look for common review container patterns
          if (parent.getAttribute('data-review-id') || 
              parent.classList.contains('jftiEf') ||
              parent.getAttribute('jsaction')?.includes('review') ||
              parent.querySelector('[aria-label*="star"]')) {
            reviewContainers.add(parent);
            break;
          }
          parent = parent.parentElement;
          depth++;
        }
        // If no container found, use the element itself or its immediate parent
        if (!parent || depth >= 10) {
          reviewContainers.add(el.parentElement || el);
        }
      });
      
      actualReviewElements = Array.from(reviewContainers);
    } else {
      actualReviewElements = Array.from(reviewElements);
    }

    console.log(`Extracting from ${actualReviewElements.length} review containers`);

    return actualReviewElements.map((el, index) => {
      // Try multiple selectors for each field
      const authorSelectors = [
        ".d4r55", 
        ".X43Kjb", 
        "[data-review-id]",
        "span[aria-label]",
        ".fontBodyMedium", // Sometimes author name uses this
        "div[aria-label*='review']"
      ];
      
      const ratingSelectors = [
        ".kvMYJc", 
        ".Fam1ne", 
        "[aria-label*='star']",
        "[aria-label*='Star']",
        "span[aria-label*='rating']",
        "div[aria-label*='rating']"
      ];
      
      const textSelectors = [
        ".wiI7pd", 
        ".MyEned", 
        ".review-full-text",
        ".fontBodyMedium",
        "[data-review-text]",
        "span.fontBodyMedium"
      ];
      
      const dateSelectors = [
        ".rsqaWe", 
        ".p4vbYd", 
        ".fnsRMc",
        "span[aria-label*='ago']",
        "span[aria-label*='month']",
        "span[aria-label*='week']"
      ];

      const findText = (selectors, context = el) => {
        for (const sel of selectors) {
          const elem = context.querySelector(sel);
          if (elem) {
            const text = elem.innerText?.trim() || elem.textContent?.trim() || "";
            if (text) return text;
          }
        }
        // Fallback: search in all text nodes
        return "";
      };

      const findRating = () => {
        // First try structured selectors
        for (const sel of ratingSelectors) {
          const elem = el.querySelector(sel);
          if (elem) {
            const ariaLabel = elem.getAttribute("aria-label") || "";
            const match = ariaLabel.match(/(\d+)/);
            if (match) return Number(match[1]);
          }
        }
        
        // Fallback: look for star emoji or rating text in the entire element
        const allText = el.innerText || el.textContent || "";
        const ratingMatch = allText.match(/(\d+)\s*star/i) || allText.match(/rated\s*(\d+)/i);
        if (ratingMatch) return Number(ratingMatch[1]);
        
        // Look for aria-label with rating anywhere in the element tree
        const allElements = el.querySelectorAll('[aria-label]');
        for (const elem of allElements) {
          const ariaLabel = elem.getAttribute("aria-label") || "";
          if (ariaLabel.includes("star") || ariaLabel.includes("Star")) {
            const match = ariaLabel.match(/(\d+)/);
            if (match) return Number(match[1]);
          }
        }
        
        return null;
      };

      // Extract fields
      const author = findText(authorSelectors);
      const rating = findRating();
      const text = findText(textSelectors);
      const date = findText(dateSelectors);

      // If we found text but no author, try to find author in parent or sibling
      let finalAuthor = author;
      if (!finalAuthor && text) {
        // Look for author in the element's context
        const parent = el.parentElement;
        if (parent) {
          finalAuthor = findText(authorSelectors, parent);
        }
      }

      return {
        author: finalAuthor,
        rating: rating,
        text: text,
        date: date
      };
    }).filter(review => {
      // Keep reviews that have at least text or author
      const hasContent = review.text || review.author;
      if (!hasContent) {
        console.log(`Filtered out empty review:`, review);
      }
      return hasContent;
    });
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

    // Alternative: try clicking all buttons with "More" text
    // Get all buttons and check their text (this catches buttons the first method might have missed)
    const allButtons = await page.$$('button');
    const clickedSelectors = new Set(expandButtons);
    
    for (const button of allButtons) {
      try {
        const buttonInfo = await button.evaluate(el => ({
          text: (el.innerText || el.textContent || '').toLowerCase(),
          ariaLabel: (el.getAttribute('aria-label') || '').toLowerCase(),
          id: el.id,
          className: el.className
        }));
        
        // Check if this button matches "more" criteria
        const isMoreButton = buttonInfo.text.includes('more') || 
                            buttonInfo.ariaLabel.includes('more') || 
                            buttonInfo.text.includes('show more') || 
                            buttonInfo.text.includes('read more');
        
        if (isMoreButton) {
          // Create a unique identifier for this button
          const buttonId = buttonInfo.id ? `#${buttonInfo.id}` : 
                          buttonInfo.className ? `.${buttonInfo.className.split(' ')[0]}` : null;
          
          // Skip if we already clicked a button with this selector
          if (!buttonId || !clickedSelectors.has(buttonId)) {
            await button.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            await delay(300);
            await button.click();
            await delay(300);
          }
        }
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

    // Try to find and click Reviews tab first (if needed)
    // Google Maps sometimes shows reviews directly, sometimes requires clicking a tab
    let reviewsFound = false;
    
    // First, check if reviews are already visible
    const initialReviews = await page.evaluate(() => {
      return document.querySelectorAll(".jftiEf, [data-review-id], .MyEned, [jsaction*='review'], .MyEned").length;
    });
    
    if (initialReviews > 0) {
      console.log(`Found ${initialReviews} reviews without clicking tab`);
      reviewsFound = true;
    } else {
      console.log("Reviews not immediately visible, looking for Reviews tab...");
      
      // Try multiple strategies to find and click the Reviews tab
      const reviewTabSelectors = [
        // Button with text "Reviews"
        "//button[contains(translate(text(), 'REVIEWS', 'reviews'), 'reviews')]",
        "//button[contains(text(), 'Reviews')]",
        "//button[contains(text(), 'REVIEWS')]",
        // Div with text "Reviews"
        "//div[contains(translate(text(), 'REVIEWS', 'reviews'), 'reviews')]",
        "//div[contains(text(), 'Reviews')]",
        // Data attributes
        '[data-value="Reviews"]',
        '[data-value="reviews"]',
        '[aria-label*="Review"]',
        '[aria-label*="review"]',
        // Tab buttons
        'button[role="tab"]:has-text("Reviews")',
        'div[role="tab"]:has-text("Reviews")',
        // Class-based selectors
        '.RWPxGd[aria-label*="Review"]',
        'button.RWPxGd',
        // More generic selectors
        '[jsaction*="review"]',
        'button:has([aria-label*="Review"])'
      ];
      
      let tabClicked = false;
      
      // Try XPath selectors first (if $x is available)
      for (const xpathSelector of reviewTabSelectors.filter(s => s.startsWith('//'))) {
        try {
          // Check if $x method exists
          if (typeof page.$x === 'function') {
            const tabs = await page.$x(xpathSelector);
            if (tabs.length > 0) {
              console.log(`Found Reviews tab with XPath: ${xpathSelector}`);
              // Scroll to element if needed
              await tabs[0].evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
              await delay(1000);
              await tabs[0].click();
              await delay(3000); // Wait for reviews to load
              tabClicked = true;
              break;
            }
          }
        } catch (e) {
          // Continue to next selector
        }
      }
      
      // Try CSS selectors
      if (!tabClicked) {
        for (const cssSelector of reviewTabSelectors.filter(s => !s.startsWith('//'))) {
          try {
            const tab = await page.$(cssSelector);
            if (tab) {
              console.log(`Found Reviews tab with CSS: ${cssSelector}`);
              await tab.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
              await delay(1000);
              await tab.click();
              await delay(3000);
              tabClicked = true;
              break;
            }
          } catch (e) {
            // Continue to next selector
          }
        }
      }
      
      // Try clicking any button/div that contains "review" in its text (case insensitive)
      if (!tabClicked) {
        try {
          const allButtons = await page.$$('button, div[role="button"], div[role="tab"]');
          for (const btn of allButtons) {
            try {
              const text = await btn.evaluate(el => el.innerText?.toLowerCase() || el.textContent?.toLowerCase() || '');
              const ariaLabel = await btn.evaluate(el => el.getAttribute('aria-label')?.toLowerCase() || '');
              
              if (text.includes('review') || ariaLabel.includes('review')) {
                console.log(`Found Reviews tab by text search: ${text || ariaLabel}`);
                await btn.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
                await delay(1000);
                await btn.click();
                await delay(3000);
                tabClicked = true;
                break;
              }
            } catch (e) {
              // Continue
            }
          }
        } catch (e) {
          console.warn("Error searching for review tabs:", e.message);
        }
      }
      
      if (tabClicked) {
        console.log("Reviews tab clicked, waiting for reviews to load...");
      } else {
        console.log("No Reviews tab found, reviews might be directly visible or page structure is different");
      }
    }
    
    // Now wait for reviews to appear with multiple selector attempts
    const reviewSelectors = [
      ".jftiEf",
      "[data-review-id]",
      ".MyEned",
      "[jsaction*='review']",
      ".fontBodyMedium",
      "[aria-label*='star']",
      ".d4r55", // Author name selector
      ".wiI7pd" // Review text selector
    ];
    
    let reviewsLoaded = false;
    for (const selector of reviewSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
        const count = await page.evaluate((sel) => {
          return document.querySelectorAll(sel).length;
        }, selector);
        if (count > 0) {
          console.log(`Found ${count} reviews using selector: ${selector}`);
          reviewsLoaded = true;
          break;
        }
      } catch (e) {
        // Try next selector
      }
    }
    
    if (!reviewsLoaded) {
      // Last attempt: scroll down to trigger lazy loading
      console.log("Scrolling page to trigger review loading...");
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => {
          window.scrollBy(0, window.innerHeight);
        });
        await delay(2000);
        
        const reviewCount = await page.evaluate(() => {
          return document.querySelectorAll(".jftiEf, [data-review-id], .MyEned, [jsaction*='review']").length;
        });
        
        if (reviewCount > 0) {
          console.log(`Found ${reviewCount} reviews after scrolling`);
          reviewsLoaded = true;
          break;
        }
      }
    }
    
    if (!reviewsLoaded) {
      // Debug: log what's actually on the page
      const pageInfo = await page.evaluate(() => {
        return {
          title: document.title,
          url: window.location.href,
          buttons: Array.from(document.querySelectorAll('button')).slice(0, 10).map(b => ({
            text: b.innerText?.substring(0, 50),
            ariaLabel: b.getAttribute('aria-label')?.substring(0, 50),
            classes: b.className
          })),
          hasReviewsSection: !!document.querySelector('[aria-label*="review" i], [aria-label*="Review"]'),
          bodyText: document.body.innerText?.substring(0, 200)
        };
      });
      
      console.error("Page debug info:", JSON.stringify(pageInfo, null, 2));
      
      throw new Error(
        "Could not find reviews section. " +
        "The page might require login, the URL might be incorrect, or Google has changed their page structure. " +
        "Check the logs for page debug information."
      );
    }

    // Expand truncated reviews
    await expandReviews(page);

    // Scroll to load more reviews
    await scrollToLoadReviews(page, 10);

    // Extract reviews
    console.log("Starting review extraction...");
    const reviews = await extractReviews(page);
    console.log(`Extracted ${reviews.length} reviews`);

    await browser.close();

    if (reviews.length === 0) {
      // Try one more time with a different approach - get all text that might be reviews
      console.log("No reviews extracted, this might indicate a selector mismatch");
      return res.status(404).json({ 
        error: "No reviews found. The selectors might have changed or the page structure is different. " +
               "Reviews were detected on the page but could not be extracted. Check logs for details." 
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
