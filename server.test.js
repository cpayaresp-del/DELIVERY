import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { menu } from './menu.js';
import { createServer } from './server.js';

const secret = 'test-secret-with-at-least-32-characters';
let server;
let baseUrl;
let database;

function createMemoryDatabase() {
  const users = [];
  const preferences = new Map();
  const addresses = [];
  const favorites = [];
  const orders = [];

  return {
    async close() {},
    findUserByEmail: async (email) => users.find((user) => user.email === email) ?? null,
    findUserById: async (id) => users.find((user) => user.id === id) ?? null,
    async createUser(user, defaults) {
      if (users.some((existing) => existing.email === user.email)) {
        throw Object.assign(new Error('Duplicate email'), { code: 11000 });
      }
      users.push(user);
      preferences.set(user.id, defaults);
    },
    async updateUserName(userId, name) {
      const user = users.find((entry) => entry.id === userId);
      user.name = name;
      return user;
    },
    async listFoods({ category, search }) {
      return menu.filter((food) =>
        (!category || category === 'all' || food.category === category)
        && (!search || `${food.name} ${food.tagline} ${food.description}`
          .toLowerCase().includes(search.toLowerCase()))
      ).sort((a, b) => Number(b.isPopular) - Number(a.isPopular) || a.name.localeCompare(b.name));
    },
    findFoodById: async (id) => menu.find((food) => food.id === id) ?? null,
    async getProfile(userId, user) {
      return {
        user,
        orderCount: orders.filter((order) => order.userId === userId).length,
        favoriteCount: favorites.filter((favorite) => favorite.userId === userId).length,
        preferences: preferences.get(userId)
      };
    },
    async updatePreferences(userId, values) {
      preferences.set(userId, values);
      return values;
    },
    async listFavorites(userId) {
      return favorites.filter((favorite) => favorite.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((favorite) => menu.find((food) => food.id === favorite.foodId));
    },
    async addFavorite(userId, foodId) {
      if (!favorites.some((item) => item.userId === userId && item.foodId === foodId)) {
        favorites.push({ userId, foodId, createdAt: new Date().toISOString() });
      }
    },
    async removeFavorite(userId, foodId) {
      const index = favorites.findIndex((item) => item.userId === userId && item.foodId === foodId);
      if (index >= 0) favorites.splice(index, 1);
    },
    async listAddresses(userId) {
      return addresses.filter((address) => address.userId === userId)
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
        .map(({ userId: _userId, createdAt: _createdAt, ...address }) => address);
    },
    async createAddress(address) {
      if (address.isDefault) {
        for (const existing of addresses) {
          if (existing.userId === address.userId) existing.isDefault = false;
        }
      }
      addresses.push(address);
      const { userId: _userId, createdAt: _createdAt, ...item } = address;
      return item;
    },
    async updateAddress(userId, id, updates) {
      const address = addresses.find((item) => item.userId === userId && item.id === id);
      if (!address) return null;
      if (updates.isDefault) {
        for (const existing of addresses) {
          if (existing.userId === userId) existing.isDefault = false;
        }
      }
      Object.assign(address, updates);
      const { userId: _userId, createdAt: _createdAt, ...item } = address;
      return item;
    },
    async deleteAddress(userId, id) {
      const index = addresses.findIndex((address) => address.userId === userId && address.id === id);
      if (index < 0) return false;
      addresses.splice(index, 1);
      return true;
    },
    async createOrder(order) {
      orders.push(order);
      const { userId: _userId, ...publicFields } = order;
      return publicFields;
    },
    async listOrders(userId) {
      return orders.filter((order) => order.userId === userId)
        .map(({ userId: _userId, ...publicFields }) => publicFields);
    },
    async findOrder(userId, id) {
      const order = orders.find((item) => item.userId === userId && item.id === id);
      if (!order) return null;
      const { userId: _userId, ...publicFields } = order;
      return publicFields;
    },
    async cancelOrder(userId, id) {
      const order = orders.find((item) => item.userId === userId && item.id === id
        && item.status === 'confirmed');
      if (!order) return null;
      order.status = 'cancelled';
      return this.findOrder(userId, id);
    }
  };
}

before(async () => {
  database = createMemoryDatabase();
  server = createServer({ database, jwtSecret: secret });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
});

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json() };
}

test('serves health and the full menu', async () => {
  assert.deepEqual(await request('/health'), { status: 200, data: { status: 'ok' } });
  const fullMenu = await request('/menu');
  assert.equal(fullMenu.data.items.length, 8);
  const response = await request('/menu?category=burger');
  assert.equal(response.status, 200);
  assert.equal(response.data.items.length, 3);
  assert.ok(response.data.items.every((food) => food.category === 'burger'));
});

test('registers, authenticates and rejects duplicate accounts', async () => {
  const created = await request('/auth/register', {
    method: 'POST',
    body: { name: 'Test User', email: 'test@example.com', password: 'strongpass1' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.email, 'test@example.com');
  assert.equal(typeof created.data.token, 'string');
  assert.equal(created.data.user.passwordHash, undefined);

  const duplicate = await request('/auth/register', {
    method: 'POST',
    body: { name: 'Another User', email: 'test@example.com', password: 'strongpass1' }
  });
  assert.equal(duplicate.status, 409);

  const login = await request('/auth/login', {
    method: 'POST',
    body: { email: 'test@example.com', password: 'strongpass1' }
  });
  assert.equal(login.status, 200);
  const me = await request('/auth/me', { token: login.data.token });
  assert.equal(me.data.user.name, 'Test User');
  assert.equal((await request('/auth/me')).status, 401);
});

test('creates orders using server prices and isolates customer data', async () => {
  const account = await request('/auth/register', {
    method: 'POST',
    body: { name: 'Order User', email: 'order@example.com', password: 'strongpass1' }
  });
  const token = account.data.token;
  const placed = await request('/orders', {
    method: 'POST',
    token,
    body: {
      items: [
        { foodId: 'deluxe_burger', quantity: 2 },
        { foodId: 'truffle_fries', quantity: 1, size: 'Large' }
      ],
      deliveryMethod: 'express',
      paymentMethod: 'cash',
      deliveryAddress: '123 Test Street'
    }
  });
  assert.equal(placed.status, 201);
  assert.equal(placed.data.order.subtotal, 47.7);
  assert.equal(placed.data.order.deliveryFee, 2.5);
  assert.equal(placed.data.order.total, 50.2);
  assert.equal(placed.data.order.paymentStatus, 'pending');
  assert.equal(placed.data.order.items.length, 2);

  const anotherAccount = await request('/auth/register', {
    method: 'POST',
    body: { name: 'Other User', email: 'other@example.com', password: 'strongpass1' }
  });
  const hiddenOrder = await request(`/orders/${placed.data.order.id}`, {
    token: anotherAccount.data.token
  });
  assert.equal(hiddenOrder.status, 404);
});

test('validates order sizes and supports saved favorites', async () => {
  const account = await request('/auth/register', {
    method: 'POST',
    body: { name: 'Favorite User', email: 'favorite@example.com', password: 'strongpass1' }
  });
  const token = account.data.token;

  assert.equal((await request('/favorites/deluxe_burger', {
    method: 'POST',
    token
  })).status, 201);
  assert.equal((await request('/favorites', { token })).data.items[0].id, 'deluxe_burger');

  const invalidOrder = await request('/orders', {
    method: 'POST',
    token,
    body: {
      items: [{ foodId: 'deluxe_burger', quantity: 1, size: 'XL' }],
      deliveryMethod: 'express',
      paymentMethod: 'cash',
      deliveryAddress: '123 Test Street'
    }
  });
  assert.equal(invalidOrder.status, 400);
});

test('saves addresses and preferences, and tracks order history', async () => {
  const account = await request('/auth/register', {
    method: 'POST',
    body: { name: 'Profile User', email: 'profile@example.com', password: 'strongpass1' }
  });
  const token = account.data.token;

  const address = await request('/addresses', {
    method: 'POST',
    token,
    body: {
      label: 'Home',
      recipient: 'Profile User',
      phone: '+1 555 0100',
      address: '123 Test Street',
      latitude: 40.7,
      longitude: -74,
      isDefault: true
    }
  });
  assert.equal(address.status, 201);
  assert.equal(address.data.item.isDefault, true);
  assert.equal((await request('/addresses', { token })).data.items[0].id, address.data.item.id);

  const preferences = await request('/profile/preferences', {
    method: 'PUT',
    token,
    body: { pushNotifications: false, darkMode: true, haptics: true }
  });
  assert.equal(preferences.data.preferences.darkMode, true);
  const profile = await request('/profile', { token });
  assert.equal(profile.data.orderCount, 0);
  assert.equal(profile.data.preferences.pushNotifications, false);

  const placed = await request('/orders', {
    method: 'POST',
    token,
    body: {
      items: [{ foodId: 'salmon_sushi', quantity: 1 }],
      deliveryMethod: 'standard',
      paymentMethod: 'cash',
      deliveryAddress: address.data.item.address
    }
  });
  assert.equal((await request('/orders', { token })).data.items.length, 1);

  const cancelled = await request(`/orders/${placed.data.order.id}`, {
    method: 'PATCH',
    token,
    body: { status: 'cancelled' }
  });
  assert.equal(cancelled.data.order.status, 'cancelled');

  assert.equal((await request(`/addresses/${address.data.item.id}`, {
    method: 'DELETE',
    token
  })).status, 200);
});
