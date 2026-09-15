import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import compression from 'compression';
import cors from 'cors';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

import { authRoutes } from './routes/authRoutes.js';
import { userRoutes } from './routes/userRoutes.js';
import { chatRoutes } from './routes/chatRoutes.js';
import { uploadRoutes } from './routes/uploadRoutes.js';
import { callRoutes } from './routes/callRoutes.js';
import { pushRoutes } from './routes/pushRoutes.js';
import { setupSocketIO, sweepDanglingCalls } from './socket/socketHandler.js';
import { configureCloudinary } from './config/cloudinary.js';
import { syncModelIndexes } from './config/syncIndexes.js';

const PORT = parseInt(process.env.PORT || '5000', 10);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/wave';
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

const app = express();
const httpServer = createServer(app);

// Global Middlewares (cors, morgan HTTP logger, JSON body parser)
app.set('trust proxy', 1);
app.use(compression());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origin === ALLOWED_ORIGIN) return callback(null, true);
      return callback(new Error('Origin is not allowed'));
    },
    credentials: true,
  })
);
app.use(morgan('dev'));
app.use(express.json());
app.use((req, res, next) => {
  const origin = req.get('origin');
  const isStateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (isStateChanging && origin && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'Request origin is not allowed' });
  }
  return next();
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/push', pushRoutes);
app.use('/api', chatRoutes);

// Health Check
app.get("/", (req,res) => {
  res.send("Wave backend production")
})

// Socket.IO Server Setup
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});
// REST handlers reach the socket server through the Express app registry
app.set('io', io);
setupSocketIO(io);

// Start HTTP & WebSockets Server
async function startServer() {
  try {
    configureCloudinary();
    console.log(`📡 Connecting to MongoDB at ${MONGODB_URI}...`);
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Mongoose connected to MongoDB successfully!');

    // autoIndex creates new indexes but never drops stale ones, so a schema change
    // stays inert against an existing database. syncIndexes closes that gap.
    // ponytail: blocks boot while an index builds — move to a migration step if a
    // collection ever grows large enough for that to matter.
    await syncModelIndexes();

    // Any call still open belongs to a previous process: log it now so it is
    // never silently lost from the conversation.
    await sweepDanglingCalls(io);

    httpServer.listen(PORT, () => {
      console.log(`🚀 Wave Express Backend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.warn(`⚠️ Connection warning for MongoDB / Server on port ${PORT}:`, err.message);
  }
}

startServer();

let isShuttingDown = false;
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Shutting down gracefully (${signal})...`);

  try {
    await io.close();
    await mongoose.connection.close(false);
    process.exit(0);
  } catch (error) {
    console.error('Graceful shutdown failed:', error.message);
    process.exit(1);
  }
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
