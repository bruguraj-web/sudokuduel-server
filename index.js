const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const sudoku = require('sudoku');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ─── Puzzle Generator ─────────────────────────────────────────
const generatePuzzle = (difficulty) => {
  let puzzle = sudoku.makepuzzle();

  if (difficulty === 'hard' || difficulty === 'legend') {
    const extras = difficulty === 'hard' ? 5 : 12;
    let removed = 0;
    while (removed < extras) {
      const idx = Math.floor(Math.random() * 81);
      if (puzzle[idx] !== null) {
        puzzle[idx] = null;
        removed++;
      }
    }
  }

  const solved = sudoku.solvepuzzle(puzzle);
  return {
    puzzle: puzzle.map(n => n !== null ? n + 1 : null),
    solved: solved.map(n => n + 1),
  };
};

// ─── Matchmaking Queues ───────────────────────────────────────
const queues = {
  easy: [],
  hard: [],
  legend: []
};

// ─── Active Rooms ─────────────────────────────────────────────
const rooms = {};

// ─── Challenge Board ──────────────────────────────────────────
const challenges = {};

// ─── Helper ───────────────────────────────────────────────────
const generateRoomId = () => Math.random().toString(36).substring(2, 10);

// ─── Health Check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('SudokuDuel server is running!');
});

// ─── Socket.IO ────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // ── Join matchmaking queue ──────────────────────────────────
  socket.on('join_queue', ({ difficulty, userId, username, points }) => {
    console.log(`${username} joining ${difficulty} queue`);

    // Remove from any existing queue first
    Object.keys(queues).forEach(d => {
      queues[d] = queues[d].filter(p => p.socketId !== socket.id);
    });

    const queue = queues[difficulty];

    if (queue.length > 0) {
      // Match found!
      const opponent = queue.shift();
      const roomId = generateRoomId();
      const puzzleData = generatePuzzle(difficulty);

      // Store room data
      rooms[roomId] = {
        difficulty,
        puzzle: puzzleData,
        players: {
          [socket.id]: {
            userId,
            username,
            points,
            progress: 0,
            mistakes: 0,
            finished: false,
            finishTime: null,
          },
          [opponent.socketId]: {
            userId: opponent.userId,
            username: opponent.username,
            points: opponent.points,
            progress: 0,
            mistakes: 0,
            finished: false,
            finishTime: null,
          }
        },
        startTime: Date.now(),
        winnerId: null,
      };

      // Join both to room
      socket.join(roomId);
      opponent.socket.join(roomId);

      // Notify both — match found
      io.to(roomId).emit('match_found', {
        roomId,
        puzzle: puzzleData.puzzle,
        difficulty,
        opponent: {
          [socket.id]: { username: opponent.username, points: opponent.points },
          [opponent.socketId]: { username, points },
        }
      });

      console.log(`Match found: ${username} vs ${opponent.username} in room ${roomId}`);

    } else {
      // Add to queue
      queue.push({
        socket,
        socketId: socket.id,
        userId,
        username,
        points,
        difficulty,
      });
      socket.emit('waiting_for_opponent');
      console.log(`${username} waiting in ${difficulty} queue`);
    }
  });

  // ── Leave queue ─────────────────────────────────────────────
  socket.on('leave_queue', () => {
    Object.keys(queues).forEach(d => {
      queues[d] = queues[d].filter(p => p.socketId !== socket.id);
    });
    console.log(`${socket.id} left queue`);
  });

  // ── Send progress update to opponent ───────────────────────
  socket.on('progress_update', ({ roomId, progress, mistakes }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Update room data
    if (room.players[socket.id]) {
      room.players[socket.id].progress = progress;
      room.players[socket.id].mistakes = mistakes;
    }

    // Send to opponent only
    socket.to(roomId).emit('opponent_update', {
      progress,
      mistakes,
    });
  });

  // ── Player finished ─────────────────────────────────────────
  socket.on('player_finished', ({ roomId, finishTime, mistakes }) => {
    const room = rooms[roomId];
    if (!room) return;

    if (room.players[socket.id]) {
      room.players[socket.id].finished = true;
      room.players[socket.id].finishTime = finishTime;
      room.players[socket.id].mistakes = mistakes;
    }

    // If no winner yet — this player is the winner
    if (!room.winnerId) {
      room.winnerId = socket.id;

      // Notify opponent that this player finished
      socket.to(roomId).emit('opponent_finished', {
        finishTime,
        mistakes,
      });

      // Notify winner
      socket.emit('you_won', {
        finishTime,
        mistakes,
      });
    }
  });

  // ── Player conceded ─────────────────────────────────────────
  socket.on('player_conceded', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Notify opponent they won
    socket.to(roomId).emit('opponent_conceded');

    // Clean up room
    delete rooms[roomId];
    console.log(`Room ${roomId} closed — player conceded`);
  });

  // ── Mistakes exceeded ───────────────────────────────────────
  socket.on('mistakes_exceeded', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Notify opponent they won by default
    socket.to(roomId).emit('opponent_mistakes_exceeded');

    // Clean up room
    delete rooms[roomId];
    console.log(`Room ${roomId} closed — mistakes exceeded`);
  });

  // ── Post challenge ──────────────────────────────────────────
  socket.on('post_challenge', ({ userId, username, points, difficulty, taunt }) => {
    const challengeId = generateRoomId();
    challenges[challengeId] = {
      challengeId,
      socketId: socket.id,
      userId,
      username,
      points,
      difficulty,
      taunt: taunt || '',
      createdAt: Date.now(),
    };

    // Broadcast to all — new challenge available
    io.emit('challenges_updated', Object.values(challenges));
    socket.emit('challenge_posted', { challengeId });
    console.log(`Challenge posted by ${username}`);

    // Auto expire after 10 minutes
    setTimeout(() => {
      if (challenges[challengeId]) {
        delete challenges[challengeId];
        io.emit('challenges_updated', Object.values(challenges));
      }
    }, 10 * 60 * 1000);
  });

  // ── Get challenges ──────────────────────────────────────────
  socket.on('get_challenges', () => {
    socket.emit('challenges_updated', Object.values(challenges));
  });

  // ── Accept challenge ────────────────────────────────────────
  socket.on('accept_challenge', ({ challengeId, userId, username, points }) => {
    const challenge = challenges[challengeId];
    if (!challenge) {
      socket.emit('challenge_expired');
      return;
    }

    // Remove from board
    delete challenges[challengeId];
    io.emit('challenges_updated', Object.values(challenges));

    const roomId = generateRoomId();
    const puzzleData = generatePuzzle(challenge.difficulty);

    // Store room
    rooms[roomId] = {
      difficulty: challenge.difficulty,
      puzzle: puzzleData,
      players: {
        [socket.id]: {
          userId,
          username,
          points,
          progress: 0,
          mistakes: 0,
          finished: false,
          finishTime: null,
        },
        [challenge.socketId]: {
          userId: challenge.userId,
          username: challenge.username,
          points: challenge.points,
          progress: 0,
          mistakes: 0,
          finished: false,
          finishTime: null,
        }
      },
      startTime: Date.now(),
      winnerId: null,
    };

    // Join both to room
    socket.join(roomId);
    const challengerSocket = io.sockets.sockets.get(challenge.socketId);
    if (challengerSocket) challengerSocket.join(roomId);

    // Notify both
    io.to(roomId).emit('match_found', {
      roomId,
      puzzle: puzzleData.puzzle,
      difficulty: challenge.difficulty,
      opponent: {
        [socket.id]: { username: challenge.username, points: challenge.points },
        [challenge.socketId]: { username, points },
      }
    });

    console.log(`Challenge accepted: ${username} vs ${challenge.username}`);
  });

  // ── Cancel challenge ────────────────────────────────────────
  socket.on('cancel_challenge', ({ challengeId }) => {
    delete challenges[challengeId];
    io.emit('challenges_updated', Object.values(challenges));
  });

  // ── Disconnect ──────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);

    // Remove from queues
    Object.keys(queues).forEach(d => {
      queues[d] = queues[d].filter(p => p.socketId !== socket.id);
    });

    // Remove their challenges
    Object.keys(challenges).forEach(id => {
      if (challenges[id].socketId === socket.id) {
        delete challenges[id];
      }
    });
    io.emit('challenges_updated', Object.values(challenges));

    // Handle active room disconnect
    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      if (room.players[socket.id]) {
        // Notify opponent they won by disconnect
        socket.to(roomId).emit('opponent_disconnected');
        delete rooms[roomId];
        console.log(`Room ${roomId} closed — player disconnected`);
      }
    });
  });
});

// ─── Start Server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`SudokuDuel server running on port ${PORT}`);
});