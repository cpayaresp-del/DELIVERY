# Food Delivery API

REST API for the Flutter app. MongoDB Atlas stores users, preferences,
addresses, favorites, orders, and the food menu. On startup, the backend seeds
the menu into the `foods` collection in the `DELIVERY` database.

## Requirements

- Node.js 22.13 or newer.
- A MongoDB Atlas cluster and database user with read/write access.

## Configure and start

```powershell
cd backend
Copy-Item .env.example .env
```

Edit `backend/.env` and set:

- `MONGODB_URI` to your Atlas connection string, with `/DELIVERY` as its
  database path.
- `MONGODB_DATABASE=DELIVERY`.
- `JWT_SECRET` to a private random value of at least 32 characters.

Add the computer's public IP to the Atlas Network Access allowlist. Then run:

```powershell
npm start
```

The API listens on port 4000. Check `http://localhost:4000/api/health`.
Never commit `.env` or share the database password. If a connection string has
been exposed, rotate its database user's password in Atlas and update `.env`.

## Connect the Android app

- Android emulator:
  `--dart-define=API_BASE_URL=http://10.0.2.2:4000/api`
- Physical Android phone: use the computer's LAN address, for example
  `--dart-define=API_BASE_URL=http://192.168.1.20:4000/api`. Connect both
  devices to the same network and allow inbound TCP port 4000 in the computer
  firewall.
- Production: deploy the API and use its HTTPS URL. Do not ship a development
  API URL or the example JWT secret in a release build.

Example Android run:

```powershell
flutter run -d <android-device-id> --dart-define=API_BASE_URL=http://10.0.2.2:4000/api
```

## Routes

Public routes:

- `GET /api/health`
- `GET /api/menu?q=&category=`
- `GET /api/menu/:foodId`
- `POST /api/auth/register` with `{ "name", "email", "password" }`
- `POST /api/auth/login` with `{ "email", "password" }`

All remaining routes require `Authorization: Bearer <token>`:

- `GET/PATCH /api/auth/me`
- `GET /api/profile`; `PUT /api/profile/preferences`
- `GET /api/favorites`; `POST/DELETE /api/favorites/:foodId`
- `GET/POST /api/addresses`; `PUT/DELETE /api/addresses/:addressId`
- `GET/POST /api/orders`; `GET/PATCH /api/orders/:orderId`

Checkout accepts `items` (`foodId`, `quantity`, optional `size`),
`deliveryMethod` (`express` or `standard`), `paymentMethod` (`cash`, `card`, or
`wallet`), and `deliveryAddress`. The API calculates prices using its own menu
records. Card and wallet orders are recorded as pending; no payment provider is
configured, and the API never stores card details. Courier GPS tracking also
needs an external delivery provider.

Run API tests with `npm test`.
