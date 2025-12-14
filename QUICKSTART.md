# Quick Start Guide - Checkout Auditor

Get up and running in 5 minutes.

## Prerequisites

- **Node.js 16+** - [Download](https://nodejs.org/)
- **OpenAI API Key** - [Get one](https://platform.openai.com/api-keys)

## Setup (5 minutes)

### 1. Install Dependencies

```bash
cd /Users/jamie/PDQ-Scraper
npm install
```

### 2. Set Environment Variables

Create a `.env` file in the project root:

```bash
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxx
PORT=3000
NODE_ENV=development

# Checkout test data (optional - defaults provided)
CHECKOUT_EMAIL=test@example.com
CHECKOUT_FIRST_NAME=Test
CHECKOUT_LAST_NAME=User
CHECKOUT_ADDRESS=123 Main St
CHECKOUT_CITY=San Francisco
CHECKOUT_STATE=CA
CHECKOUT_ZIP=94102
CHECKOUT_COUNTRY=US
CHECKOUT_PHONE=5551234567
```

> **Note:** Keep your `OPENAI_API_KEY` secret! Add `.env` to `.gitignore` (already done).

### 3. Build TypeScript

```bash
npm run build
```

### 4. Start the Server

**Development (with auto-reload):**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

You should see:
```
🚀 Checkout Auditor Server running on http://localhost:3000
📊 Frontend: http://localhost:3000
🔌 API Health: http://localhost:3000/api/health
```

## First Audit (30 seconds)

### Via Web UI

1. **Open browser:** http://localhost:3000
2. **Enter domain:** `nike.com` (or any domain)
3. **Click:** "Run Audit"
4. **Watch:** Timeline populates with stages as they complete
5. **View:** Screenshots by clicking them
6. **Export:** CSV when done with the "Export CSV" button

### Via API (curl)

```bash
# Start audit
curl -X POST http://localhost:3000/api/audit \
  -H "Content-Type: application/json" \
  -d '{"domain":"example.com"}'

# Response: {"jobId":"abc123..."}

# Check status (replace abc123 with real jobId)
curl http://localhost:3000/api/audit/abc123

# Download CSV
curl -X POST http://localhost:3000/api/download-csv \
  -H "Content-Type: application/json" \
  -d '{"jobId":"abc123"}' \
  -o results.csv
```

## What to Expect

### Timeline Output

For each stage (homepage, product, cart, checkout), you'll see:

```
📸 Screenshot
💎 Feature Pills
  - EDD (green) = Delivery promise detected
  - Upsells (blue) = Cross-sells found
  - FST (yellow) = Free shipping threshold
  - Add-on (purple) = Shipping protection
  - Trust (red) = Security badges

📝 Evidence Snippets
  - Exact quotes from the page that triggered detections

📋 Notes
  - Any issues encountered during that stage
```

### Cost

- **First audit:** ~$0.0005 (mostly rules, minimal LLM)
- **100 audits:** ~$0.05
- **1,000 audits:** ~$0.50

## Troubleshooting

### "PORT already in use"

```bash
# Change port in .env
PORT=3001

# Or kill existing process
lsof -ti:3000 | xargs kill -9
```

### "OPENAI_API_KEY not found"

```bash
# Make sure .env file exists and has your key
cat .env | grep OPENAI_API_KEY

# Or set directly
export OPENAI_API_KEY=sk-proj-xxx
npm run dev
```

### "Failed to load homepage"

- Check the domain is accessible in your browser
- Try a different domain (e.g., `amazon.com`)
- Verify your internet connection

### "Screenshot folder not created"

```bash
# Create artifacts directory
mkdir -p artifacts
npm run dev
```

## Next Steps

### Batch Audits

Audit multiple domains at once:

1. Switch to **"Batch Upload"** tab
2. Paste domains (one per line):
   ```
   example.com
   shop.example.org
   store.example.net
   ```
3. Click "Run Batch Audit"
4. Results appear in timeline progressively

### API Integration

Use the API in your own apps:

```javascript
// Start audit
const response = await fetch('/api/audit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ domain: 'example.com' })
});

const { jobId } = await response.json();

// Poll status
const statusResponse = await fetch(`/api/audit/${jobId}`);
const job = await statusResponse.json();

console.log(job.stages); // Array of stage results
```

### Production Deployment

```bash
# Build once
npm run build

# Use PM2 for process management
npm install -g pm2
pm2 start dist/server.js --name "checkout-auditor"

# Or use Docker
docker build -t checkout-auditor .
docker run -p 3000:3000 -e OPENAI_API_KEY=sk-... checkout-auditor
```

## Key Files

| File | Purpose |
|------|---------|
| `src/server.ts` | Express API server |
| `src/checkout.ts` | Playwright checkout automation |
| `src/detections.ts` | Feature detection logic |
| `public/index.html` | Web UI |
| `public/app.js` | Frontend JavaScript |

## Common Domains to Test

- `nike.com` - Good for EDD + upsells
- `shopify-store.com` - Standard checkout flow
- `amazon.com` - Complex checkout
- `etsy.com` - Varied checkouts

## Support

- 📖 **Full docs:** See `README.md`
- 🐛 **Issues:** GitHub Issues (once on GitHub)
- 💬 **Questions:** Check troubleshooting above

---

**You're all set! Start an audit now. 🚀**

