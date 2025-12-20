import mongoose from 'mongoose';

let connectPromise: Promise<typeof mongoose> | null = null;

export function connectMongo() {
  if (!connectPromise) {
    // Try both DATABASE_URL (Render) and MONGODB_URI (local/other platforms)
    const uri = process.env.DATABASE_URL || process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('DATABASE_URL or MONGODB_URI is missing. Set it in your environment variables.');
    }
    console.log('Connecting to MongoDB...', uri.replace(/\/\/.*@/, '//*****@')); // Mask credentials
    connectPromise = mongoose.connect(uri);
  }
  return connectPromise;
}

export async function getDb() {
  const conn = await connectMongo();
  return conn.connection.db;
}
