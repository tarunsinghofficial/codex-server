const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const ACTIONS = require("./actions");

const app = express();
app.use(cors({ origin: "*" }));

const server = http.createServer(app);
const port = process.env.PORT || 5000;

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000, // Increase ping timeout
  pingInterval: 25000, // Increase ping interval
});

const userSocketMap = {};
const roomStates = new Map(); // Store room states

function getAllConnectedClients(roomId) {
  return Array.from(io.sockets.adapter.rooms.get(roomId) || []).map(
    (socketId) => ({
      socketId,
      username: userSocketMap[socketId],
    })
  );
}

// Debounce function for code updates
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

io.on("connection", (socket) => {
  console.log("server connected", socket.id);
  
  // Handle room joining
  socket.on(ACTIONS.JOIN, ({ roomId, username }) => {
    userSocketMap[socket.id] = username;
    socket.join(roomId);
    
    // Initialize room state if it doesn't exist
    if (!roomStates.has(roomId)) {
      roomStates.set(roomId, {
        code: "",
        version: 0,
        lastUpdate: Date.now()
      });
    }
    
    const clients = getAllConnectedClients(roomId);
    const roomState = roomStates.get(roomId);
    
    // Notify all clients in the room
    clients.forEach(({ socketId }) => {
      io.to(socketId).emit(ACTIONS.JOINED, {
        clients,
        username,
        socketId: socket.id,
        currentCode: roomState.code,
        version: roomState.version
      });
    });
  });

  // Debounced code change handler
  const debouncedCodeChange = debounce(({ roomId, code, version }) => {
    const roomState = roomStates.get(roomId);
    if (roomState && version > roomState.version) {
      roomState.code = code;
      roomState.version = version;
      roomState.lastUpdate = Date.now();
      socket.broadcast.to(roomId).emit(ACTIONS.CODE_CHANGE, {
        code,
        version
      });
    }
  }, 100); // 100ms debounce

  socket.on(ACTIONS.CODE_CHANGE, debouncedCodeChange);

  socket.on(ACTIONS.SYNC_CODE, ({ socketId, code, version }) => {
    socket.to(socketId).emit(ACTIONS.CODE_CHANGE, { code, version });
  });

  socket.on("disconnecting", () => {
    const rooms = [...socket.rooms];
    rooms.forEach((roomId) => {
      socket.in(roomId).emit(ACTIONS.DISCONNECTED, {
        socketId: socket.id,
        username: userSocketMap[socket.id],
      });
    });
    delete userSocketMap[socket.id];
    socket.leave();
  });
  
  // Handle explicit disconnect
  socket.on("disconnect", () => {
    console.log("Client disconnected", socket.id);
  });
});

// Periodic cleanup of inactive rooms
setInterval(() => {
  const now = Date.now();
  for (const [roomId, state] of roomStates.entries()) {
    if (now - state.lastUpdate > 24 * 60 * 60 * 1000) { // 24 hours
      roomStates.delete(roomId);
    }
  }
}, 60 * 60 * 1000); // Check every hour

server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});