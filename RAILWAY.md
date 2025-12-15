# Railway Deployment Configuration

## API Key
```
RAILWAY_API_KEY=40547504-12a4-4cd8-85a9-86d2b8423166
```

## Deployment Commands

### Login to Railway
```bash
railway login
```

### Link to existing project
```bash
railway link
```

### Deploy
```bash
railway up
```

## Environment Variables (set in Railway dashboard)

Required:
- `OPENAI_API_KEY` - Your OpenAI API key for LLM-based detections

Optional (defaults provided):
- `PORT` - Auto-set by Railway (defaults to 3001)
- `CHECKOUT_EMAIL` - Default checkout email
- `CHECKOUT_FIRST_NAME` - Default first name
- `CHECKOUT_LAST_NAME` - Default last name
- `CHECKOUT_ADDRESS` - Default address
- `CHECKOUT_CITY` - Default city
- `CHECKOUT_STATE` - Default state
- `CHECKOUT_ZIP` - Default zip
- `CHECKOUT_COUNTRY` - Default country
- `CHECKOUT_PHONE` - Default phone
- `CHECKOUT_CARD` - Default card number
- `CHECKOUT_CARD_NAME` - Default card name
- `CHECKOUT_CARD_EXPIRY` - Default card expiry
- `CHECKOUT_CARD_CVV` - Default card CVV

## API Endpoints

Once deployed, your API will be available at:
`https://your-app-name.railway.app`

### Health Check
```
GET /api/health
```

### Synchronous Audit (for Clay/n8n)
```
POST /api/audit-sync
Body: { "domain": "gymshark.com" }
Returns: Full AuditResult JSON (waits for completion)
Timeout: 180 seconds
```

### Async Audit (existing)
```
POST /api/audit
Body: { "domain": "gymshark.com" }
Returns: { "jobId": "..." }
Then poll: GET /api/audit/:jobId
```

### Batch Sync Audit
```
POST /api/audit-batch-sync
Body: { "domains": ["gymshark.com", "allbirds.com"] }
Returns: { "results": [AuditResult, ...] }
```

## Usage Examples

### Synchronous API (for Clay/n8n):
```bash
curl -X POST https://your-app-name.railway.app/api/audit-sync \
  -H "Content-Type: application/json" \
  -d '{"domain": "gymshark.com"}' \
  --max-time 180
```

### Clay Configuration:
- HTTP Request node
- Method: POST
- URL: `https://your-app-name.railway.app/api/audit-sync`
- Body: `{"domain": "{{domain}}"}`
- Timeout: 180 seconds

### n8n Configuration:
- HTTP Request node
- Method: POST
- URL: `https://your-app-name.railway.app/api/audit-sync`
- Body: JSON with `domain` field
- Options → Timeout: 180000ms

## Response Format

```json
{
  "domain": "gymshark.com",
  "jobId": "abc-123",
  "startedAt": "2025-12-14T21:00:00.000Z",
  "completedAt": "2025-12-14T21:01:30.000Z",
  "status": "completed",
  "stages": [
    {
      "key": "summary",
      "url": "https://gymshark.com",
      "screenshotUrl": "https://your-app-name.railway.app/artifacts/.../summary.jpg",
      "notes": [],
      "detections": {
        "edd": { "present": true, "confidence": 0.9, "evidence": [...] },
        "upsells": { "present": false, "confidence": 0, "evidence": [] },
        "fstBar": { "present": false, "confidence": 0, "evidence": [] },
        "shippingAddon": { "present": false, "confidence": 0, "evidence": [] },
        "trustBadges": { "present": true, "confidence": 0.8, "evidence": [...] }
      },
      "extractedSnippets": [...]
    },
    ...
  ]
}
```

## Notes

- Screenshot URLs are absolute (include full domain)
- Each audit takes 30-60+ seconds
- Supports concurrent requests (limited by server resources)
- Maximum 3-5 concurrent audits recommended per instance

