import { MongoClient } from 'mongodb';
import { menu } from './menu.js';

export const DATABASE_NAME = 'DELIVERY';

export async function openDatabase({
  uri = process.env.MONGODB_URI,
  databaseName = DATABASE_NAME
} = {}) {
  if (!uri) throw new Error('MONGODB_URI must be configured.');
  if (!uri.startsWith('mongodb+srv://') && !uri.startsWith('mongodb://')) {
    throw new Error('MONGODB_URI must be a MongoDB connection string.');
  }
  if (databaseName !== DATABASE_NAME) {
    throw new Error(`This app uses the "${DATABASE_NAME}" database.`);
  }

  const client = new MongoClient(uri, {
    dbName: DATABASE_NAME,
    serverSelectionTimeoutMS: 10_000
  });
  await client.connect();
  const db = client.db(DATABASE_NAME);

  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('addresses').createIndex({ userId: 1, isDefault: -1, createdAt: -1 }),
    db.collection('favorites').createIndex({ userId: 1, createdAt: -1 }),
    db.collection('favorites').createIndex({ userId: 1, foodId: 1 }, { unique: true }),
    db.collection('orders').createIndex({ userId: 1, createdAt: -1 })
  ]);

  const foods = db.collection('foods');
  await foods.bulkWrite(
    menu.map((food) => ({
      updateOne: {
        filter: { id: food.id },
        update: { $setOnInsert: food },
        upsert: true
      }
    })),
    { ordered: true }
  );

  return {
    async close() {
      await client.close();
    },

    findUserByEmail(email) {
      return db.collection('users').findOne({ email });
    },
    findUserById(id) {
      return db.collection('users').findOne({ id });
    },
    async createUser(user, preferences) {
      await db.collection('users').insertOne(user);
      await db.collection('userPreferences').insertOne({
        userId: user.id,
        ...preferences
      });
      return user;
    },
    async updateUserName(userId, name) {
      await db.collection('users').updateOne({ id: userId }, { $set: { name } });
      return db.collection('users').findOne({ id: userId });
    },

    async listFoods({ category, search }) {
      const filter = {};
      if (category && category !== 'all') filter.category = category;
      if (search) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [
          { name: { $regex: escaped, $options: 'i' } },
          { tagline: { $regex: escaped, $options: 'i' } },
          { description: { $regex: escaped, $options: 'i' } }
        ];
      }
      return db.collection('foods').find(filter)
        .sort({ isPopular: -1, name: 1 })
        .toArray();
    },
    findFoodById(id) {
      return db.collection('foods').findOne({ id });
    },

    async getProfile(userId, user) {
      const [orderCount, favoriteCount, preferences] = await Promise.all([
        db.collection('orders').countDocuments({ userId }),
        db.collection('favorites').countDocuments({ userId }),
        db.collection('userPreferences').findOne({ userId })
      ]);
      return {
        user,
        orderCount,
        favoriteCount,
        preferences: {
          pushNotifications: preferences.pushNotifications,
          darkMode: preferences.darkMode,
          haptics: preferences.haptics
        }
      };
    },
    async updatePreferences(userId, preferences) {
      await db.collection('userPreferences').updateOne(
        { userId },
        { $set: preferences },
        { upsert: true }
      );
      return preferences;
    },

    async listFavorites(userId) {
      const ids = await db.collection('favorites').find({ userId })
        .sort({ createdAt: -1 })
        .project({ _id: 0, foodId: 1 })
        .toArray();
      if (ids.length === 0) return [];
      const byId = new Map(
        (await db.collection('foods').find({
          id: { $in: ids.map((item) => item.foodId) }
        }).toArray()).map((food) => [food.id, food])
      );
      return ids.map((item) => byId.get(item.foodId)).filter(Boolean);
    },
    async addFavorite(userId, foodId) {
      await db.collection('favorites').updateOne(
        { userId, foodId },
        { $setOnInsert: { userId, foodId, createdAt: new Date().toISOString() } },
        { upsert: true }
      );
    },
    async removeFavorite(userId, foodId) {
      await db.collection('favorites').deleteOne({ userId, foodId });
    },

    async listAddresses(userId) {
      const addresses = await db.collection('addresses').find({ userId })
        .sort({ isDefault: -1, createdAt: -1 })
        .toArray();
      return addresses.map(addressFromDocument);
    },
    async createAddress(address) {
      const { userId, ...publicAddress } = address;
      if (address.isDefault) {
        await db.collection('addresses').updateMany({ userId }, { $set: { isDefault: false } });
      }
      await db.collection('addresses').insertOne(address);
      return publicAddress;
    },
    async updateAddress(userId, id, updates) {
      const addresses = db.collection('addresses');
      const existing = await addresses.findOne({ id, userId });
      if (!existing) return null;
      if (updates.isDefault) {
        await addresses.updateMany({ userId }, { $set: { isDefault: false } });
      }
      await addresses.updateOne({ id, userId }, { $set: updates });
      return addressFromDocument(await addresses.findOne({ id, userId }));
    },
    async deleteAddress(userId, id) {
      const result = await db.collection('addresses').deleteOne({ id, userId });
      return result.deletedCount === 1;
    },

    async createOrder(order) {
      await db.collection('orders').insertOne(order);
      return publicOrder(order);
    },
    async listOrders(userId) {
      const orders = await db.collection('orders').find({ userId })
        .sort({ createdAt: -1 })
        .toArray();
      return orders.map(publicOrder);
    },
    async findOrder(userId, id) {
      return publicOrder(await db.collection('orders').findOne({ id, userId }));
    },
    async cancelOrder(userId, id) {
      const result = await db.collection('orders').updateOne(
        { id, userId, status: 'confirmed' },
        { $set: { status: 'cancelled' } }
      );
      return result.modifiedCount === 1 ? this.findOrder(userId, id) : null;
    }
  };
}

export function addressFromDocument(address) {
  if (!address) return null;
  return {
    id: address.id,
    label: address.label,
    recipient: address.recipient,
    phone: address.phone,
    address: address.address,
    latitude: address.latitude,
    longitude: address.longitude,
    isDefault: address.isDefault
  };
}

export function publicOrder(order) {
  if (!order) return null;
  const { userId, _id, ...publicFields } = order;
  return publicFields;
}
