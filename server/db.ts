import mongoose from 'mongoose';

let connectPromise: Promise<typeof mongoose> | null = null;

export function connectMongo() {
  if (!connectPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGODB_URI is missing. Set it in your .env file.');
    }
    connectPromise = mongoose.connect(uri);
  }
  return connectPromise;
}

export async function getDb() {
  const conn = await connectMongo();
  return conn.connection.db;
}
