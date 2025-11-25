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
    // Focus on actual review containers, not business listings
    const reviewSelectors = [
      ".jftiEf",                                // Legacy review container
      "[data-review-id]",                       // Data attribute used historically
      "[jsaction*='review'][jsaction*='pane']", // Review pane containers
      "div[jscontroller*='xd0Rqe']",            // New jscontroller containers
      "div[jscontroller*='eIu7Db']",            // Alternate jscontroller
      "[aria-label*='review'][role='article']", // Screen reader friendly containers
      "div[role='article']",                    // Generic article containers
    ];

    const collectCandidates = (selector) => {
      try {
        return Array.from(document.querySelectorAll(selector));
      } catch {
        return [];
      }
    };

    const hasReviewSignals = (el) => {
      if (!el) return false;
      return !!(
        el.querySelector(".wiI7pd, .MyEned, [class*='wiI7pd']") ||
        el.querySelector(".d4r55, .X43Kjb, [class*='d4r55']") ||
        el.querySelector("[aria-label*='star'], [aria-label*='Star']")
      );
    };

    let reviewElements = [];
    let usedSelector = null;

    for (const selector of reviewSelectors) {
      const candidates = collectCandidates(selector).filter(hasReviewSignals);
      if (candidates.length > 0) {
        reviewElements = candidates;
        usedSelector = selector;
        console.log(`Using selector: ${selector}, found ${reviewElements.length} elements`);
        break;
      }
    }

    // If primary selectors don't work, try finding reviews by structure
    if (reviewElements.length === 0) {
      // Start from review text nodes
      const textNodes = collectCandidates(".wiI7pd, .MyEned, [class*='wiI7pd']");
      const authorNodes = collectCandidates(".d4r55, .X43Kjb, [class*='d4r55']");
      const ratingNodes = collectCandidates("[aria-label*='star'], [aria-label*='Star']");
      const potentialReviews = [];

      const collectClosestContainer = (node) => {
        if (!node) return null;
        const candidates = [
          node.closest("[data-review-id]"),
          node.closest("[jscontroller]"),
          node.closest("[role='article']"),
          node.closest(".jftiEf"),
        ];
        return candidates.find(Boolean) || node.parentElement;
      };

      [...textNodes, ...authorNodes, ...ratingNodes].forEach(node => {
        const container = collectClosestContainer(node);
        if (container && hasReviewSignals(container)) {
          potentialReviews.push(container);
        }
      });

      reviewElements = Array.from(new Set(potentialReviews));
      if (reviewElements.length > 0) {
        usedSelector = "structure-based";
        console.log(`Using structure-based detection, found ${reviewElements.length} potential reviews`);
      }
    }

    if (reviewElements.length === 0) {
      console.log("No review elements found with any selector");
      return [];
    }

    const actualReviewElements = Array.from(reviewElements);
    console.log(`Extracting from ${actualReviewElements.length} review containers`);

    // Helper function to check if text looks like business info (not a review)
    const isBusinessInfo = (text) => {
      if (!text) return false;
      const lower = text.toLowerCase();
      // Patterns that indicate business information, not reviews
      return /^\d+\.\d+\(\d+\)$/.test(text.trim()) || // "4.1(470)"
             lower.includes('coffee shop') ||
             lower.includes('coffee chain') ||
             lower.includes('closes') ||
             lower.includes('open') ||
             lower.includes('phone') ||
             /^\$\d+/.test(text.trim()) || // Price range "$1–10"
             /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(text) || // Phone numbers
             /\d+\s+\w+\s+(rd|st|ave|blvd|street|road)/i.test(text); // Addresses
    };

    // Helper function to check if author looks like a real name (not business rating)
    const isRealAuthor = (author) => {
      if (!author) return false;
      // Business ratings look like "4.1(470)" - not a name
      if (/^\d+\.\d+\(\d+\)$/.test(author.trim())) return false;
      // Real names usually have letters and might have spaces
      return /[a-zA-Z]/.test(author) && author.length > 2;
    };

    // Debug: Log first container structure
    if (actualReviewElements.length > 0) {
      const firstEl = actualReviewElements[0];
      const debugInfo = {
        className: firstEl.className,
        innerHTML: firstEl.innerHTML.substring(0, 500),
        children: Array.from(firstEl.children).map(c => ({
          tag: c.tagName,
          className: c.className,
          text: (c.innerText || c.textContent || '').substring(0, 100)
        }))
      };
      console.log("First review container debug:", JSON.stringify(debugInfo, null, 2));
    }

    const extractedReviews = actualReviewElements.map((el, index) => {
      // Try multiple selectors for each field - be more specific
      const authorSelectors = [
        ".d4r55",           // Primary author selector
        ".X43Kjb",         // Alternative
        "span.d4r55",      // More specific
        "div.d4r55",       // Container variant
        "[class*='d4r55']", // Partial class match
        "span[class*='fontBodyMedium']", // Alternative author style
        "div[class*='fontBodyMedium']"
      ];
      
      const ratingSelectors = [
        ".kvMYJc",         // Primary rating selector
        ".Fam1ne",         // Alternative
        "[aria-label*='star']",
        "[aria-label*='Star']",
        "span[aria-label*='star']",
        "div[aria-label*='star']"
      ];
      
      const textSelectors = [
        ".wiI7pd",         // Primary review text selector
        ".MyEned",          // Alternative
        "span.wiI7pd",      // More specific
        "div.wiI7pd",       // Container variant
        "[class*='wiI7pd']", // Partial class match
        "span[class*='fontBodyMedium']", // Alternative text style
        "div[class*='fontBodyMedium']"
      ];
      
      const dateSelectors = [
        ".rsqaWe",          // Primary date selector
        ".p4vbYd",          // Alternative
        ".fnsRMc",          // Another variant
        "span.rsqaWe",      // More specific
        "[class*='rsqaWe']", // Partial class match
        "span[class*='fontBodySmall']", // Alternative date style
        "div[class*='fontBodySmall']"
      ];

      const findText = (selectors, context = el) => {
        for (const sel of selectors) {
          try {
            const elem = context.querySelector(sel);
            if (elem) {
              const text = elem.innerText?.trim() || elem.textContent?.trim() || "";
              if (text && !isBusinessInfo(text)) return text;
            }
          } catch (e) {
            // Invalid selector, continue
          }
        }
        return "";
      };

      const findRating = () => {
        // First try structured selectors for user review ratings
        for (const sel of ratingSelectors) {
          try {
            const elem = el.querySelector(sel);
            if (elem) {
              const ariaLabel = elem.getAttribute("aria-label") || "";
              // Look for patterns like "Rated 5 out of 5 stars" or "5 stars"
              const match = ariaLabel.match(/(\d+)\s*(out of|star)/i);
              if (match) {
                const rating = Number(match[1]);
                if (rating >= 1 && rating <= 5) return rating;
              }
            }
          } catch (e) {
            // Invalid selector, continue
          }
        }
        
        // Look for aria-label with rating anywhere in the element tree
        try {
          const allElements = el.querySelectorAll('[aria-label]');
          for (const elem of allElements) {
            const ariaLabel = elem.getAttribute("aria-label") || "";
            if (ariaLabel.includes("star") || ariaLabel.includes("Star")) {
              const match = ariaLabel.match(/(\d+)\s*(out of|star)/i);
              if (match) {
                const rating = Number(match[1]);
                if (rating >= 1 && rating <= 5) return rating;
              }
            }
          }
        } catch (e) {
          // Continue
        }
        
        return null;
      };

      // Extract fields with validation
      let author = findText(authorSelectors);
      let rating = findRating();
      let text = findText(textSelectors);
      let date = findText(dateSelectors);

      // If we didn't find author with specific selectors, try a more general approach
      if (!author) {
        // Look for text that looks like a name (has letters, reasonable length)
        const allTextNodes = Array.from(el.querySelectorAll('span, div')).map(e => ({
          text: (e.innerText || e.textContent || '').trim(),
          elem: e
        })).filter(e => e.text && e.text.length > 2 && e.text.length < 50);
        
        for (const node of allTextNodes) {
          // Check if it looks like a name (not a rating, not business info)
          if (!isBusinessInfo(node.text) && 
              !/^\d+\.\d+\(\d+\)$/.test(node.text) &&
              /[a-zA-Z]/.test(node.text) &&
              !node.text.includes('star') &&
              !node.text.match(/^\d+\s*(out of|star)/i)) {
            // Check if this element is positioned early in the container (likely author)
            const rect = node.elem.getBoundingClientRect();
            const containerRect = el.getBoundingClientRect();
            if (rect.top < containerRect.top + containerRect.height * 0.3) {
              author = node.text;
              break;
            }
          }
        }
      }

      // If we didn't find text with specific selectors, try a more general approach
      if (!text || text.length < 10) {
        // Look for longer text blocks that might be review content
        const allTextNodes = Array.from(el.querySelectorAll('span, div')).map(e => ({
          text: (e.innerText || e.textContent || '').trim(),
          elem: e
        })).filter(e => e.text && e.text.length > 20);
        
        for (const node of allTextNodes) {
          // Check if it looks like review text (not business info, not a name)
          if (!isBusinessInfo(node.text) && 
              !/^\d+\.\d+\(\d+\)$/.test(node.text) &&
              !node.text.match(/^\d+\s*(out of|star)/i) &&
              node.text.length > 20 &&
              !node.text.includes('star')) {
            // Check if this element is positioned in the middle/bottom of container (likely review text)
            const rect = node.elem.getBoundingClientRect();
            const containerRect = el.getBoundingClientRect();
            if (rect.top > containerRect.top + containerRect.height * 0.2) {
              text = node.text;
              break;
            }
          }
        }
      }

      // Validate this is actually a review, not business info
      if (!isRealAuthor(author) && !text) {
        // Skip if it doesn't look like a real review
        return null;
      }

      // Filter out business information from text
      let cleanText = text;
      if (cleanText && isBusinessInfo(cleanText)) {
        cleanText = "";
      }

      // If text contains business info patterns, try to extract just the review part
      if (cleanText && (cleanText.includes('Coffee shop') || cleanText.includes('Closes'))) {
        // Try to find the actual review text within
        const lines = cleanText.split('\n');
        cleanText = lines.find(line => 
          line.length > 20 && 
          !isBusinessInfo(line) &&
          !line.match(/^\d+\.\d+\(\d+\)/) &&
          !line.includes('Coffee') &&
          !line.includes('Closes')
        ) || "";
      }

      return {
        author: isRealAuthor(author) ? author : "",
        rating: rating,
        text: cleanText,
        date: date
      };
    }).filter(review => {
      // Only keep reviews that have:
      // 1. A real author name OR review text (not business info)
      // 2. Review text should be meaningful (more than just a rating)
      const hasRealAuthor = review.author && isRealAuthor(review.author);
      const hasReviewText = review.text && review.text.length > 10 && !isBusinessInfo(review.text);
      const hasRating = review.rating !== null;
      
      // More lenient validation: accept if we have author OR text OR rating
      const isValid = hasRealAuthor || hasReviewText || hasRating;
      
      if (!isValid) {
        console.log(`Filtered out invalid review:`, review);
      }
      return isValid;
    });

    console.log(`Extracted ${extractedReviews.length} valid reviews out of ${actualReviewElements.length} containers`);
    return extractedReviews;
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

    // Check if new reviews loaded (use specific review container selectors)
    const currentCount = await page.evaluate(() => {
      return document.querySelectorAll(".jftiEf, [data-review-id], [jsaction*='review'][jsaction*='pane']").length;
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
    
    // Wait a bit for page to fully render
    await delay(3000);
    
    // First, check if reviews are already visible
    const initialReviews = await page.evaluate(() => {
      return document.querySelectorAll(".jftiEf, [data-review-id], [jsaction*='review'][jsaction*='pane'], .wiI7pd, .d4r55").length;
    });
    
    if (initialReviews > 0) {
      console.log(`Found ${initialReviews} reviews without clicking tab`);
      reviewsFound = true;
    } else {
      console.log("Reviews not immediately visible, looking for Reviews tab...");
      
      // Scroll down a bit to make sure the page is fully loaded
      await page.evaluate(() => {
        window.scrollBy(0, 500);
      });
      await delay(2000);
      
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
          // Get all potential clickable elements and check their text
          const allClickables = await page.$$('button, div[role="button"], div[role="tab"], span[role="button"], a[role="button"]');
          console.log(`Checking ${allClickables.length} clickable elements for reviews...`);
          
          for (const btn of allClickables) {
            try {
              const elementInfo = await btn.evaluate(el => ({
                text: (el.innerText || el.textContent || '').toLowerCase(),
                ariaLabel: (el.getAttribute('aria-label') || '').toLowerCase(),
                visible: el.offsetParent !== null
              }));
              
              if (elementInfo.visible && (elementInfo.text.includes('review') || elementInfo.ariaLabel.includes('review'))) {
                console.log(`Found Reviews tab by text search: ${elementInfo.text.substring(0, 50) || elementInfo.ariaLabel.substring(0, 50)}`);
                await btn.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
                await delay(1500);
                await btn.click();
                await delay(4000); // Wait longer for reviews to load
                tabClicked = true;
                break;
              }
            } catch (e) {
              // Continue to next element
            }
          }
        } catch (e) {
          console.warn("Error searching for review tabs:", e.message);
        }
      }
      
      if (tabClicked) {
        console.log("Reviews tab clicked, waiting for reviews to load...");
        // Wait longer and scroll to trigger loading
        await delay(3000);
        
        // Scroll within the reviews section if it exists
        await page.evaluate(() => {
          // Try to find the reviews panel/container
          const reviewPanel = document.querySelector('[role="main"]') || 
                             document.querySelector('[jsaction*="review"]') ||
                             document.body;
          if (reviewPanel) {
            reviewPanel.scrollTop = reviewPanel.scrollHeight / 2;
          }
        });
        await delay(2000);
      } else {
        console.log("No Reviews tab found, trying to scroll to find reviews...");
        // Even if no tab was clicked, try scrolling to find reviews
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => {
            window.scrollBy(0, window.innerHeight);
          });
          await delay(2000);
          
          const scrollReviews = await page.evaluate(() => {
            return document.querySelectorAll(".jftiEf, [data-review-id], .wiI7pd, .d4r55").length;
          });
          
          if (scrollReviews > 0) {
            console.log(`Found ${scrollReviews} reviews after scrolling`);
            reviewsFound = true;
            break;
          }
        }
      }
    }
    
    // Now wait for reviews to appear with multiple selector attempts
    // Use specific review container selectors, not broad ones like .fontBodyMedium
    const reviewSelectors = [
      ".jftiEf",              // Primary review container
      "[data-review-id]",     // Data attribute based
      "[jsaction*='review'][jsaction*='pane']", // Review pane
      ".MyEned",              // Alternative container
      ".wiI7pd",              // Review text (indicates review exists)
      ".d4r55"                // Author name (indicates review exists)
    ];
    
    let reviewsLoaded = reviewsFound; // Start with what we found earlier
    
    if (!reviewsLoaded) {
      // Try waiting for selectors with longer timeout
      for (const selector of reviewSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 15000 });
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
    }
    
    if (!reviewsLoaded) {
      // Last attempt: scroll down to trigger lazy loading with more attempts
      console.log("Scrolling page to trigger review loading...");
      for (let i = 0; i < 8; i++) {
        await page.evaluate(() => {
          // Try scrolling both window and any scrollable containers
          window.scrollBy(0, window.innerHeight);
          
          // Also try scrolling review-specific containers
          const containers = document.querySelectorAll('[role="main"], [jsaction*="review"], [data-review-id]');
          containers.forEach(container => {
            if (container.scrollHeight > container.clientHeight) {
              container.scrollTop = container.scrollHeight;
            }
          });
        });
        await delay(2500);
        
        const reviewCount = await page.evaluate(() => {
          return document.querySelectorAll(".jftiEf, [data-review-id], [jsaction*='review'][jsaction*='pane'], .wiI7pd, .d4r55").length;
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

    // Debug: Check what review elements are actually present before extraction
    const debugInfo = await page.evaluate(() => {
      const containerSelectors = [
        ".jftiEf",
        "[data-review-id]",
        "[jsaction*='review'][jsaction*='pane']",
        "div[jscontroller*='xd0Rqe']",
        "div[jscontroller*='eIu7Db']",
        "[aria-label*='review'][role='article']",
        "div[role='article']"
      ];
      const containers = document.querySelectorAll(containerSelectors.join(","));
      const sampleContainer = containers[0];
      
      if (!sampleContainer) {
        const fallbackText = document.querySelector(".wiI7pd, .MyEned, [class*='wiI7pd']");
        return { 
          error: "No review containers found",
          fallbackText: fallbackText?.innerText?.substring(0, 200) || null,
          availableSelectors: containerSelectors,
          domSummary: document.body.innerText.substring(0, 200)
        };
      }

      return {
        containerCount: containers.length,
        sampleContainer: {
          className: sampleContainer.className,
          innerHTML: sampleContainer.innerHTML.substring(0, 1000),
          hasAuthor: !!sampleContainer.querySelector('.d4r55, .X43Kjb, [class*="d4r55"]'),
          hasRating: !!sampleContainer.querySelector('[aria-label*="star"], [aria-label*="Star"]'),
          hasText: !!sampleContainer.querySelector('.wiI7pd, .MyEned, [class*="wiI7pd"]'),
          hasDate: !!sampleContainer.querySelector('.rsqaWe, .p4vbYd, [class*="rsqaWe"]'),
          allClasses: Array.from(sampleContainer.querySelectorAll('[class]')).slice(0, 10).map(e => e.className),
          allAriaLabels: Array.from(sampleContainer.querySelectorAll('[aria-label]')).slice(0, 10).map(e => e.getAttribute('aria-label'))
        }
      };
    });
    
    console.log("Pre-extraction debug info:", JSON.stringify(debugInfo, null, 2));

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
