# Wave — Backend Server

The backend for **Wave — Your people, a tap away.** Wave is a personal, private messenger for one-to-one conversations between friends, family, and partners — it is not a workplace or team tool, and has no concept of organisations, roles, or admins. It powers private messaging, Cloudinary file sharing, presence, and LiveKit voice and video calls using **Express**, **MongoDB**, **Mongoose**, and **Socket.IO**.

## 🚀 Installed Packages & Stack
- **Web Framework:** Express (`express`)
- **HTTP Logger:** Morgan (`morgan`)
- **CORS Middleware:** Cors (`cors`)
- **Validation Engine:** Express-Validator (`express-validator`)
- **Environment Management:** Dotenv (`dotenv`)
- **Dev Live Reload:** Nodemon (`nodemon`)
- **Database & ORM:** MongoDB & Mongoose (`mongoose`)
- **Auth & Security:** JWT (`jsonwebtoken`) & Password Hashing (`bcryptjs`)
- **Real-time WebSockets:** Socket.IO (`socket.io`)

---

## 📁 Directory Structure
```
wave-server/
├── .env                  # Environment variables (PORT, MONGODB_URI, JWT_SECRET)
├── .env.example          # Environment variables template
├── package.json          # Plain JS ES Modules setup ("type": "module")
└── src/
    ├── index.js          # Main Express & Socket.IO server entrypoint
    ├── middleware/
    │   ├── authMiddleware.js # JWT bearer token validator
    │   └── validate.js       # express-validator error handler
    ├── models/
    │   ├── User.js           # Mongoose User schema & model
    │   ├── Conversation.js   # Mongoose Conversation schema
    │   └── Message.js        # Mongoose Message schema
    ├── routes/
    │   ├── authRoutes.js     # /api/auth/signup, /api/auth/login, /api/auth/me
    │   ├── userRoutes.js     # /api/users (find people by name/email)
    │   └── chatRoutes.js     # /api/conversations, /api/messages/:id
    └── socket/
        └── socketHandler.js  # Real-time Socket.IO gateway & presence
```

---

## 🛠️ How to Run

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Start Dev Server (with Nodemon hot-reloading):**
   ```bash
   npm run dev
   ```

3. **Start Production Server:**
   ```bash
   npm start
   ```

---

## 🔌 Validated API Endpoints

All inputs are sanitized and validated with `express-validator`:
- `POST /api/auth/signup` - Register new user (validates `name`, `email`, `password`)
- `POST /api/auth/login` - Authenticate user & receive JWT token
- `GET /api/auth/me` - Fetch authenticated user session profile
- `GET /api/users?search=...` - Find people by name or email
- `GET /api/conversations` - Fetch user's active conversations
- `GET /api/messages/:conversationId` - Fetch chat thread history
- `POST /api/conversations/start` - Start or retrieve direct conversation
- `WS socket.io` - Real-time `send_message`, `receive_message`, and `presence_change` events
