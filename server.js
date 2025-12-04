// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = 8000;

app.use(express.json());
app.use(
  cors({
    origin: "http://localhost:3000",
  })
);

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

// In-memory rooms
// roomId -> { roomId, content }
const rooms = {};

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      roomId,
      content: "// New Seditor room\n",
    };
  }
  return rooms[roomId];
}

// ---------------- HTTP ----------------

app.post("/rooms", (req, res) => {
  const roomId = uuidv4();
  getOrCreateRoom(roomId);
  res.json({ roomId });
});

app.get("/rooms/:roomId", (req, res) => {
  const { roomId } = req.params;
  const room = getOrCreateRoom(roomId);
  res.json({ roomId: room.roomId, content: room.content });
});

app.get("/", (req, res) => {
  res.send("Seditor backend is running");
});

// ---------------- Socket.IO ----------------

/*
Client emits:
- "join_room", { roomId }
- "code_change", { roomId, content }

Server emits:
- "init", { roomId, content }
- "code_change", { roomId, content }  // to others only
*/

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("join_room", ({ roomId }) => {
    if (!roomId) return;
    const room = getOrCreateRoom(roomId);

    socket.join(roomId);
    console.log(`Socket ${socket.id} joined room ${roomId}`);

    // send current content only to THIS client
    socket.emit("init", {
      roomId,
      content: room.content,
    });
  });

  socket.on("code_change", ({ roomId, content }) => {
    if (!roomId) return;
    const room = getOrCreateRoom(roomId);
    room.content = content;

    // IMPORTANT: send to others, NOT to sender
    socket.to(roomId).emit("code_change", {
      roomId,
      content,
    });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Seditor backend listening on http://localhost:${PORT}`);
});
