# OrderEase — Distributor Ordering Platform

OrderEase is a full-stack, mobile-first distributor ordering PWA for Company A (Jabalpur). It includes retailer, salesman and order-desk workflows with demo data.

## Features

- **Retailer portal:** OTP login, retailer-specific catalogue prices, stock and schemes, credit balance, cart, order history and repeat order.
- **Salesman portal:** assigned retailer selector, shop catalogue, order entry and offline queue stored in IndexedDB. Pending orders synchronize when connectivity returns; server rechecks stock, price and credit and uses an idempotency key to avoid duplicate sync orders.
- **AI order capture:** Hindi/Hinglish/English text parser with optional LLM; photo interpretation through a vision model when configured, otherwise browser OCR (Tesseract); Hindi voice-note upload through speech transcription when configured and browser microphone speech recognition where supported. Every line is editable and must be confirmed; ambiguous units are blocked. Desk SKU corrections are saved as retailer-specific aliases.
- **Scheme engine:** buy-10-get-1 free goods and 3% slab discount from 5 cases; calculations and stock checks run on the server.
- **Order desk:** queue review, rejection/confirmation, credit holds and credit-account adjustments, Tally-compatible CSV export, consolidated van loading list, and retailers inactive for at least 14 days.
- **PWA:** installable manifest and service worker cache the application shell; catalogue is cached in local storage for salesman offline use.

## Requirements

- Node.js 20 or newer (Node 22 LTS recommended)
- npm
- Internet for first dependency installation. AI/SMS providers are optional for local demo.

## Run locally (Windows / VS Code)

1. Extract the ZIP and open the folder containing this `package.json` in VS Code.
2. Open a terminal in that folder and run:

   ```bash
   npm install
   npm run install:all
   ```

3. Copy `server/.env.example` to `server/.env`. Set a long random `JWT_SECRET`. Leave Twilio and AI variables blank for the local demo.
4. Start both services:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:5173`. API health check: `http://localhost:5000/api/health`.

### Demo logins

| Role | Phone | OTP |
|---|---|---|
| Retailer — Ramesh Kirana | 9000000001 | 123456 |
| Retailer — Sita General Store | 9000000002 | 123456 |
| Order desk | 9000000099 | 123456 |
| Salesman — Amit | 9000000088 | 123456 |

The demo OTP is intentionally not production authentication. Configure Twilio Verify to send and verify real OTPs. In production the API refuses to use the demo OTP and requires a strong `JWT_SECRET` and Twilio credentials.

## Environment variables

See `server/.env.example`. Names only: `PORT`, `NODE_ENV`, `JWT_SECRET`, `CLIENT_ORIGIN`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`, `DEFAULT_COUNTRY_CODE`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_VISION_MODEL`, `AI_TRANSCRIPTION_MODEL`.

## Tests

```bash
npm test
```

The scheme engine tests cover free goods, slab thresholds and invalid quantities. API and end-to-end checks are listed in `deployment.md`.

## Important demo assumptions and limits

- Sample prices are treated as GST-inclusive because the brief does not provide GST rates or tax breakup. The app labels this clearly; the CSV carries the inclusive line amount and GST field is zero in the demo.
- SMS OTP, LLM/vision and voice-note transcription need provider credentials. Without an AI key, text uses a transparent deterministic Hindi/Hinglish parser; photo uses in-browser OCR; microphone speech recognition depends on browser support.
- Handwritten OCR and speech recognition can be imperfect. Low-confidence or unclear entries require human correction; the system never silently submits an AI suggestion.
- Offline order sync queues the order locally and validates current price, stock and credit when it reaches the server. It does not promise stale stock availability.
- SQLite via sql.js is used for a portable demo. For production and concurrent use, migrate to managed PostgreSQL, configure backups, HTTPS, monitoring, rate limiting and a real OTP provider.
- No delivery tracking, in-app payment or GST e-invoicing is implemented, per the brief.
