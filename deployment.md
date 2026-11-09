# OrderEase deployment and reviewer guide

## Local setup

1. Install Node.js 20+ (Node 22 LTS recommended) and npm.
2. Extract the project ZIP and open the project root (the folder containing the root `package.json`).
3. Run `npm install`.
4. Run `npm run install:all` to install server and client dependencies.
5. Copy `server/.env.example` to `server/.env`.
6. Set `JWT_SECRET` to a random value of at least 32 characters. For local demo, keep `NODE_ENV=development` and leave Twilio/AI credentials blank.
7. Run `npm run dev`.
8. Visit `http://localhost:5173`; API health is at `http://localhost:5000/api/health`.

## Demo reviewer accounts

| Role | Phone | OTP |
|---|---|---|
| Retailer | 9000000001 | 123456 |
| Retailer | 9000000002 | 123456 |
| Salesman | 9000000088 | 123456 |
| Order desk | 9000000099 | 123456 |

Demo OTP is only for development. Production requires Twilio Verify credentials; the server will not accept the demo OTP in production.

## Deployment model

- Frontend: deploy `client` as a static Vite site (build command `npm run build`, output directory `dist`). Set `VITE_API_URL` to the public API base ending in `/api`.
- Backend: deploy `server` as a Node service (start command `npm start`). Set `CLIENT_ORIGIN` to the deployed frontend origin and `PORT` from the hosting provider.
- Database: this demo uses a local sql.js SQLite file at `server/data/orderease.sqlite`. On a host with ephemeral storage, attach a persistent volume. For production or multiple instances, migrate to managed PostgreSQL; SQLite file sharing across instances is not supported.
- PWA: serve the frontend over HTTPS for installability and service-worker support.

## Environment variable names (never commit values)

`PORT`, `NODE_ENV`, `JWT_SECRET`, `CLIENT_ORIGIN`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`, `DEFAULT_COUNTRY_CODE`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_VISION_MODEL`, `AI_TRANSCRIPTION_MODEL`, `VITE_API_URL`.

Twilio Verify is optional in local demo but required in production. AI text/vision and voice-note transcription use an OpenAI-compatible API when `AI_API_KEY` is configured. The text parser has a local fallback; photo capture has a Tesseract browser OCR fallback; the live microphone feature uses browser speech recognition when supported.

## Feature verification checklist

1. **Retailer:** log in as `9000000001`; verify catalogue, personalized price, scheme, stock, credit balance, add-to-cart and submit.
2. **Repeat order:** open My Orders and select Repeat order. A new order should appear in the order desk queue.
3. **AI text:** paste `bhaiya 5 peti biscuit chhota, 2 peti washing powder 1 kilo, chai patti 250 wala 1 peti`. Check each SKU, unit, quantity and confidence. Tea is out of stock and should be flagged when order validation runs. No AI order should be created until confirmation.
4. **Photo:** upload a clear product list photo. With `AI_API_KEY`, vision extraction is used; without it, browser OCR is used and the extracted text must be reviewed.
5. **Voice:** upload a Hindi audio note with AI credentials, or use Record Hindi in a browser supporting Web Speech API. Review the transcript and extracted items.
6. **Salesman/offline:** log in as `9000000088`, choose an assigned retailer, load the catalogue while online, switch the device offline and submit an order. It should appear in Offline queue. Restore internet and sync; the server revalidates stock, current price and credit.
7. **Order desk:** log in as `9000000099`; review the incoming order. A credit-held order cannot be confirmed until its retailer's credit account is adjusted in Credit accounts. Confirm an order; stock and outstanding credit update.
8. **Tally:** export confirmed orders as CSV.
9. **Van loading:** view consolidated paid/free cases, then mark confirmed orders loaded.
10. **Inactive retailers:** verify retailers with no order in the last 14 days appear in the dashboard.
11. **Access control:** try opening another retailer's catalogue/credit using a different retailer ID; the API must reject the request.

## Tests

Run `npm test` from the project root. The current automated suite covers scheme-engine calculations. Complete the feature verification checklist above for API/UI integration before submission.

## Demo limitations / assumptions

- Sample prices are treated as GST-inclusive; no GST rate/tax breakup was supplied.
- Tally export is CSV, not a direct Tally integration.
- The voice note transcription API and vision model require provider credentials. Browser microphone recognition and OCR are fallback options, with variable accuracy.
- Offline orders are queued in IndexedDB and revalidated at sync; stock is not reserved while offline.
- This is a single-instance demo using sql.js SQLite. Use managed PostgreSQL, persistent backups, rate limiting, monitoring and stronger operational controls before production use.
