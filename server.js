import { createServer as createHttpServer } from 'node:http';
import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual
} from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openDatabase } from './database.js';

const scrypt = promisify(scryptCallback);
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_BODY_BYTES = 1024 * 1024;
const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const categories = new Set(['burger', 'hotdog', 'sushi', 'salad', 'sides']);
const deliveryMethods = new Set(['express', 'standard']);
const paymentMethods = new Set(['cash', 'card', 'wallet']);

function apiError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createToken(userId, secret) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: userId,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS
  })}`;
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw apiError(401, 'Invalid or expired session.');
  const body = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw apiError(401, 'Invalid or expired session.');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw apiError(401, 'Invalid or expired session.');
  }
  if (typeof payload.sub !== 'string' || payload.exp <= Date.now() / 1000) {
    throw apiError(401, 'Invalid or expired session.');
  }
  return payload.sub;
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function passwordMatches(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt
  };
}

function send(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  response.end(body);
}

async function readJson(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw apiError(415, 'Content-Type must be application/json.');
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw apiError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') {
      throw new Error('Expected an object.');
    }
    return body;
  } catch {
    throw apiError(400, 'Request body must be a valid JSON object.');
  }
}

function stringField(value, label, min = 1, max = 250) {
  if (typeof value !== 'string') throw apiError(400, `${label} is required.`);
  const result = value.trim();
  if (result.length < min || result.length > max) {
    throw apiError(400, `${label} must be ${min}-${max} characters.`);
  }
  return result;
}

function buildRouter({ database, jwtSecret, corsOrigin }) {
  return async (request, response) => {
    const origin = request.headers.origin;
    if (corsOrigin === '*' || (origin && origin === corsOrigin)) {
      response.setHeader('Access-Control-Allow-Origin', corsOrigin === '*' ? '*' : origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const url = new URL(request.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api') throw apiError(404, 'Route not found.');
      const route = parts.slice(1);
      const method = request.method;

      if (method === 'GET' && route.join('/') === 'health') {
        send(response, 200, { status: 'ok' });
        return;
      }

      if (method === 'POST' && route.join('/') === 'auth/register') {
        const body = await readJson(request);
        const name = stringField(body.name, 'Name', 2, 80);
        const email = stringField(body.email, 'Email', 5, 254).toLowerCase();
        const password = stringField(body.password, 'Password', 8, 128);
        if (!validEmail.test(email)) throw apiError(400, 'Enter a valid email address.');
        const id = randomUUID();
        const user = {
          id,
          name,
          email,
          passwordHash: await hashPassword(password),
          createdAt: new Date().toISOString()
        };
        try {
          await database.createUser(user, {
            pushNotifications: true,
            darkMode: false,
            haptics: false
          });
        } catch (error) {
          if (error.code === 11000) {
            throw apiError(409, 'An account with this email already exists.');
          }
          throw error;
        }
        send(response, 201, { token: createToken(id, jwtSecret), user: publicUser(user) });
        return;
      }

      if (method === 'POST' && route.join('/') === 'auth/login') {
        const body = await readJson(request);
        const email = stringField(body.email, 'Email', 5, 254).toLowerCase();
        const password = stringField(body.password, 'Password', 1, 128);
        const user = await database.findUserByEmail(email);
        if (!user || !(await passwordMatches(password, user.passwordHash))) {
          throw apiError(401, 'Email or password is incorrect.');
        }
        send(response, 200, { token: createToken(user.id, jwtSecret), user: publicUser(user) });
        return;
      }

      if (method === 'GET' && route.join('/') === 'menu') {
        const search = (url.searchParams.get('q') ?? '').trim();
        const category = (url.searchParams.get('category') ?? '').trim();
        if (category && category !== 'all' && !categories.has(category)) {
          throw apiError(400, 'Unknown menu category.');
        }
        send(response, 200, {
          items: await database.listFoods({ category, search })
        });
        return;
      }

      if (method === 'GET' && route.length === 2 && route[0] === 'menu') {
        const food = await database.findFoodById(route[1]);
        if (!food) throw apiError(404, 'Menu item not found.');
        send(response, 200, { item: food });
        return;
      }

      const authorization = request.headers.authorization ?? '';
      const match = /^Bearer ([^\s]+)$/.exec(authorization);
      if (!match) throw apiError(401, 'Sign in to continue.');
      const userId = verifyToken(match[1], jwtSecret);
      const currentUser = await database.findUserById(userId);
      if (!currentUser) throw apiError(401, 'Session user no longer exists.');

      if (method === 'GET' && route.join('/') === 'auth/me') {
        send(response, 200, { user: publicUser(currentUser) });
        return;
      }

      if (method === 'PATCH' && route.join('/') === 'auth/me') {
        const body = await readJson(request);
        const name = stringField(body.name, 'Name', 2, 80);
        const user = await database.updateUserName(userId, name);
        send(response, 200, { user: publicUser(user) });
        return;
      }

      if (method === 'GET' && route.join('/') === 'profile') {
        send(response, 200, await database.getProfile(userId, publicUser(currentUser)));
        return;
      }

      if (method === 'PUT' && route.join('/') === 'profile/preferences') {
        const body = await readJson(request);
        for (const key of ['pushNotifications', 'darkMode', 'haptics']) {
          if (typeof body[key] !== 'boolean') throw apiError(400, `${key} must be a boolean.`);
        }
        const preferences = await database.updatePreferences(userId, {
          pushNotifications: body.pushNotifications,
          darkMode: body.darkMode,
          haptics: body.haptics
        });
        send(response, 200, { preferences });
        return;
      }

      if (route[0] === 'favorites') {
        if (route.length === 1 && method === 'GET') {
          send(response, 200, { items: await database.listFavorites(userId) });
          return;
        }
        if (route.length === 2 && method === 'POST') {
          if (!await database.findFoodById(route[1])) throw apiError(404, 'Menu item not found.');
          await database.addFavorite(userId, route[1]);
          send(response, 201, { favorite: { foodId: route[1] } });
          return;
        }
        if (route.length === 2 && method === 'DELETE') {
          await database.removeFavorite(userId, route[1]);
          send(response, 200, { removed: true });
          return;
        }
      }

      if (route[0] === 'addresses') {
        if (route.length === 1 && method === 'GET') {
          send(response, 200, { items: await database.listAddresses(userId) });
          return;
        }
        if (route.length === 1 && method === 'POST') {
          const body = await readJson(request);
          if (body.isDefault !== undefined && typeof body.isDefault !== 'boolean') {
            throw apiError(400, 'isDefault must be a boolean.');
          }
          const address = {
            id: randomUUID(),
            userId,
            label: stringField(body.label, 'Label', 1, 40),
            recipient: stringField(body.recipient, 'Recipient', 2, 80),
            phone: stringField(body.phone, 'Phone', 3, 32),
            address: stringField(body.address, 'Address', 5, 300),
            latitude: body.latitude ?? null,
            longitude: body.longitude ?? null,
            isDefault: Boolean(body.isDefault),
            createdAt: new Date().toISOString()
          };
          if (address.latitude !== null && (typeof address.latitude !== 'number' || Math.abs(address.latitude) > 90)) {
            throw apiError(400, 'Latitude is invalid.');
          }
          if (address.longitude !== null && (typeof address.longitude !== 'number' || Math.abs(address.longitude) > 180)) {
            throw apiError(400, 'Longitude is invalid.');
          }
          const item = await database.createAddress(address);
          send(response, 201, { item });
          return;
        }
        if (route.length === 2 && method === 'PUT') {
          const body = await readJson(request);
          if (body.isDefault !== undefined && typeof body.isDefault !== 'boolean') {
            throw apiError(400, 'isDefault must be a boolean.');
          }
          const updates = {
            label: stringField(body.label, 'Label', 1, 40),
            recipient: stringField(body.recipient, 'Recipient', 2, 80),
            phone: stringField(body.phone, 'Phone', 3, 32),
            address: stringField(body.address, 'Address', 5, 300),
            latitude: body.latitude ?? null,
            longitude: body.longitude ?? null,
            isDefault: Boolean(body.isDefault)
          };
          if (updates.latitude !== null && (typeof updates.latitude !== 'number' || Math.abs(updates.latitude) > 90)) {
            throw apiError(400, 'Latitude is invalid.');
          }
          if (updates.longitude !== null && (typeof updates.longitude !== 'number' || Math.abs(updates.longitude) > 180)) {
            throw apiError(400, 'Longitude is invalid.');
          }
          const item = await database.updateAddress(userId, route[1], updates);
          if (!item) throw apiError(404, 'Address not found.');
          send(response, 200, { item });
          return;
        }
        if (route.length === 2 && method === 'DELETE') {
          if (!await database.deleteAddress(userId, route[1])) {
            throw apiError(404, 'Address not found.');
          }
          send(response, 200, { removed: true });
          return;
        }
      }

      if (route[0] === 'orders' && route.length === 1 && method === 'POST') {
        const body = await readJson(request);
        if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
          throw apiError(400, 'Order must contain between 1 and 50 items.');
        }
        if (!deliveryMethods.has(body.deliveryMethod)) throw apiError(400, 'Invalid delivery method.');
        if (!paymentMethods.has(body.paymentMethod)) throw apiError(400, 'Invalid payment method.');
        const deliveryAddress = stringField(body.deliveryAddress, 'Delivery address', 5, 300);

        const requestedItems = new Map();
        for (const item of body.items) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw apiError(400, 'Each order item must be an object.');
          }
          const foodId = stringField(item.foodId, 'Food ID', 1, 80);
          if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
            throw apiError(400, 'Item quantity must be between 1 and 99.');
          }
          const size = item.size == null ? null : stringField(item.size, 'Size', 1, 40);
          const quantity = (requestedItems.get(foodId)?.quantity ?? 0) + item.quantity;
          if (quantity > 99) throw apiError(400, 'Total quantity per menu item cannot exceed 99.');
          requestedItems.set(foodId, { foodId, quantity, size });
        }

        const orderItems = [];
        for (const item of requestedItems.values()) {
          const food = await database.findFoodById(item.foodId);
          if (!food) throw apiError(400, `Menu item "${item.foodId}" is unavailable.`);
          if (item.size && !food.sizes.includes(item.size)) {
            throw apiError(400, `Invalid size for ${food.name}.`);
          }
          orderItems.push({
            foodId: food.id,
            name: food.name,
            unitPrice: food.price,
            quantity: item.quantity,
            size: item.size
          });
        }

        const subtotal = Math.round(
          orderItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0) * 100
        ) / 100;
        const deliveryFee = body.deliveryMethod === 'express' ? 2.5 : 0;
        const order = {
          id: randomUUID(),
          userId,
          status: 'confirmed',
          subtotal,
          deliveryFee,
          total: Math.round((subtotal + deliveryFee) * 100) / 100,
          deliveryMethod: body.deliveryMethod,
          paymentMethod: body.paymentMethod,
          paymentStatus: 'pending',
          deliveryAddress,
          etaMinutes: body.deliveryMethod === 'express' ? 20 : 38,
          createdAt: new Date().toISOString(),
          items: orderItems
        };
        send(response, 201, { order: await database.createOrder(order) });
        return;
      }

      if (route[0] === 'orders' && route.length === 1 && method === 'GET') {
        send(response, 200, { items: await database.listOrders(userId) });
        return;
      }

      if (route[0] === 'orders' && route.length === 2) {
        if (method === 'GET') {
          const order = await database.findOrder(userId, route[1]);
          if (!order) throw apiError(404, 'Order not found.');
          send(response, 200, { order });
          return;
        }
        if (method === 'PATCH') {
          const body = await readJson(request);
          if (body.status !== 'cancelled') throw apiError(400, 'Only order cancellation is supported.');
          const order = await database.cancelOrder(userId, route[1]);
          if (!order) throw apiError(409, 'This order can no longer be cancelled.');
          send(response, 200, { order });
          return;
        }
      }

      throw apiError(404, 'Route not found.');
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error(error);
      send(response, status, {
        error: status === 500 ? 'Internal server error.' : error.message
      });
    }
  };
}

export function createServer({
  database,
  jwtSecret = process.env.JWT_SECRET,
  corsOrigin = process.env.CORS_ORIGIN ?? '*'
} = {}) {
  if (!database) throw new Error('A connected database is required.');
  if (typeof jwtSecret !== 'string' || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters.');
  }
  return createHttpServer(buildRouter({ database, jwtSecret, corsOrigin }));
}

async function start() {
  const port = Number.parseInt(process.env.PORT ?? '4000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port.');
  }
  const host = process.env.HOST ?? '0.0.0.0';
  const database = await openDatabase({
    databaseName: process.env.MONGODB_DATABASE ?? 'DELIVERY'
  });
  const server = createServer({ database });
  server.on('close', () => void database.close());
  server.listen(port, host, () => {
    console.log(`Food Delivery API connected to MongoDB "${process.env.MONGODB_DATABASE ?? 'DELIVERY'}" and listening on http://${host}:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error(
      'Could not start the Food Delivery API. Check the MongoDB URI, database access, Atlas IP allowlist, and JWT_SECRET.',
      error.name
    );
    process.exitCode = 1;
  });
}
