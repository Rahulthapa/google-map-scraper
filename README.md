# Google Maps Review Scraper

A Node.js scraper that fetches reviews from Google Maps without using the official API. Built with Express and Puppeteer.

## Features

- ✅ Scrapes Google Maps reviews without API
- ✅ Handles truncated reviews (expands "More" buttons)
- ✅ Smart scrolling to load more reviews
- ✅ Multiple selector fallbacks for reliability
- ✅ Bot detection mitigation
- ✅ URL validation
- ✅ Error handling and resource cleanup

## Installation

```bash
npm install
```

## Usage

Start the server:
```bash
npm start
```

The server will run on `http://localhost:3000`

### API Endpoint

**GET** `/scrape?url=<GOOGLE_MAPS_URL>`

Example:
```bash
curl "http://localhost:3000/scrape?url=https://www.google.com/maps/place/Your+Place+Name"
```

### Response Format

```json
{
  "success": true,
  "count": 10,
  "url": "https://www.google.com/maps/place/...",
  "reviews": [
    {
      "author": "John Doe",
      "rating": 5,
      "text": "Great place!",
      "date": "2 weeks ago"
    }
  ]
}
```

## Important Notes

### ⚠️ Limitations

1. **Selector Fragility**: Google Maps frequently changes their HTML structure and CSS class names. The scraper includes multiple selector fallbacks, but may break if Google makes significant changes.

2. **Rate Limiting**: Google may detect and block automated requests. The scraper includes anti-detection measures, but excessive use may result in:
   - CAPTCHA challenges
   - IP blocking
   - Temporary bans

3. **Legal Considerations**: 
   - Scraping may violate Google's Terms of Service
   - Use responsibly and at your own risk
   - Consider using the official Google Places API for production use

4. **Performance**: Each scrape launches a full browser instance, which is resource-intensive. Consider:
   - Implementing request queuing
   - Adding caching
   - Using a browser pool for multiple requests

### 🔧 Improvements Made

The code has been enhanced with:

1. **Multiple Selector Fallbacks**: Tries different CSS selectors if primary ones fail
2. **Review Expansion**: Automatically clicks "More" buttons to get full review text
3. **Smart Scrolling**: Detects when no new reviews are loading and stops scrolling
4. **Bot Detection Mitigation**: Sets realistic user agent and viewport
5. **URL Validation**: Ensures only valid Google Maps URLs are processed
6. **Better Error Handling**: Proper resource cleanup and informative error messages
7. **CORS Support**: Can be used from frontend applications

## Troubleshooting

### No reviews found
- Verify the URL is a valid Google Maps place URL
- Check if the page requires login
- Google may have changed their HTML structure (selectors need updating)

### Timeout errors
- Increase timeout values in the code
- Check your internet connection
- Google may be rate limiting your requests

### Empty review text
- Reviews might be truncated and expansion failed
- Some reviews may only have ratings without text

## Development

To run in development mode with detailed error messages:
```bash
NODE_ENV=development npm start
```

## License

MIT

## Disclaimer

This tool is for educational purposes. Always respect website terms of service and robots.txt files. Use responsibly and consider the legal implications of web scraping.

