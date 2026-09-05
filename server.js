const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// پایگاه داده موقت حافظه
let users = {}; // { username: { username, password, coins, trophies, isOwner } }
let globalChat = [];
let waitingPlayer = null; // صف انتظار آنلاین
let activeRooms = {}; // اتاق‌های بازی فعال
let gameTimers = {}; // تایمرهای ۳۰ ثانیه‌ای برای هر روم

// ادمین پیش‌فرض
users['kiarash'] = { username: 'کیارش', password: '123', coins: 1000, trophies: 50, isOwner: true };

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('register_user', ({ username, password }) => {
        if (!username || !password) {
            return socket.emit('error_msg', 'لطفاً تمام فیلدها را پر کنید');
        }
        if (users[username]) {
            return socket.emit('error_msg', 'این نام کاربری قبلاً ثبت‌نام کرده است');
        }

        users[username] = {
            username,
            password,
            coins: 50, // سکه اولیه رایگان
            trophies: 0,
            isOwner: (username.toLowerCase() === 'kiarash')
        };
        currentUser = username;
        socket.data.username = username;

        socket.emit('login_success', { user: users[username], isOwner: users[username].isOwner });
        broadcastLeaderboard();
        broadcastUserList();
        socket.emit('init_global_chat', globalChat);
    });

    socket.on('login_user', ({ username, password }) => {
        if (!users[username] || users[username].password !== password) {
            return socket.emit('error_msg', 'نام کاربری یا رمز عبور اشتباه است');
        }
        currentUser = username;
        socket.data.username = username;

        socket.emit('login_success', { user: users[username], isOwner: users[username].isOwner });
        broadcastLeaderboard();
        broadcastUserList();
        socket.emit('init_global_chat', globalChat);
    });

    // چت عمومی
    socket.on('send_global_chat', (message) => {
        if (!currentUser || !users[currentUser]) return;
        const msgData = {
            username: currentUser,
            message,
            isOwner: users[currentUser].isOwner
        };
        globalChat.push(msgData);
        if (globalChat.length > 50) globalChat.shift();
        io.emit('receive_global_chat', msgData);
    });

    // جستجوی حریف آنلاین
    socket.on('find_game', () => {
        if (!currentUser || !users[currentUser]) return;
        if (users[currentUser].coins < 10) {
            return socket.emit('error_msg', 'سکه شما برای ورود به نبرد کافی نیست! (حداقل ۱۰ سکه)');
        }

        if (waitingPlayer && waitingPlayer.socketId !== socket.id) {
            const roomId = 'room_' + Date.now();
            const p1 = waitingPlayer;
            const p2 = { socketId: socket.id, username: currentUser };
            waitingPlayer = null;

            users[p1.username].coins -= 10;
            users[p2.username].coins -= 10;
            
            io.to(p1.socketId).emit('update_stats', users[p1.username]);
            io.to(p2.socketId).emit('update_stats', users[p2.username]);

            const playerIds = [p1.socketId, p2.socketId];
            const firstPlayerId = playerIds[Math.random() < 0.5 ? 0 : 1];
            const secondPlayerId = playerIds.find(id => id !== firstPlayerId);

            const symbols = {
                [firstPlayerId]: 'X',
                [secondPlayerId]: 'O'
            };

            const playersMap = {
                [p1.socketId]: p1.username,
                [p2.socketId]: p2.username
            };

            const room = {
                roomId,
                players: playersMap,
                symbols,
                turn: firstPlayerId,
                board: Array(9).fill(null)
            };

            activeRooms[roomId] = room;

            p1.socket.join(roomId);
            socket.join(roomId);

            io.to(roomId).emit('game_start', {
                roomId,
                players: playersMap,
                symbols,
                turn: firstPlayerId
            });

            startTurnTimer(roomId);

        } else {
            waitingPlayer = { socketId: socket.id, socket, username: currentUser };
        }
    });

    socket.on('cancel_search', () => {
        if (waitingPlayer && waitingPlayer.socketId === socket.id) {
            waitingPlayer = null;
            socket.emit('search_cancelled');
        }
    });

    // ثبت حرکت بازیکن در بازی آنلاین
    socket.on('make_move', ({ roomId, index }) => {
        const room = activeRooms[roomId];
        if (!room || room.turn !== socket.id) return;
        if (room.board[index] !== null) return;

        const symbol = room.symbols[socket.id];
        room.board[index] = symbol;

        if (checkWin(room.board, symbol)) {
            clearRoomTimer(roomId);
            const winnerSocketId = socket.id;
            const loserSocketId = Object.keys(room.players).find(id => id !== winnerSocketId);
            const winnerName = room.players[winnerSocketId];
            
            users[winnerName].coins += 80;
            users[winnerName].trophies += 5;

            io.to(roomId).emit('game_over', {
                board: room.board,
                isDraw: false,
                winnerName
            });

            updateUserStatsDirect(winnerSocketId, users[winnerName]);
            if (users[room.players[loserSocketId]]) {
                updateUserStatsDirect(loserSocketId, users[room.players[loserSocketId]]);
            }
            delete activeRooms[roomId];
            broadcastLeaderboard();
            return;
        }

        if (room.board.every(cell => cell !== null)) {
            clearRoomTimer(roomId);
            io.to(roomId).emit('game_over', {
                board: room.board,
                isDraw: true,
                winnerName: null
            });
            delete activeRooms[roomId];
            return;
        }

        const playerIds = Object.keys(room.players);
        room.turn = playerIds.find(id => id !== room.turn);

        io.to(roomId).emit('update_board', {
            board: room.board,
            turn: room.turn
        });

        startTurnTimer(roomId);
    });

    socket.on('surrender_game', ({ roomId }) => {
        handleGameOverBySurrender(roomId, socket.id);
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.socketId === socket.id) {
            waitingPlayer = null;
        }
        for (const roomId in activeRooms) {
            const room = activeRooms[roomId];
            if (room && room.players && room.players[socket.id]) {
                handleGameOverBySurrender(roomId, socket.id);
                break;
            }
        }
    });

    // بازی با ربات
    let botGame = null;
    socket.on('start_bot_game', ({ difficulty }) => {
        botGame = {
            board: Array(9).fill(null),
            turn: 'X',
            difficulty
        };
        socket.emit('bot_game_start', { board: botGame.board });
    });

    socket.on('make_bot_move', ({ index }) => {
        if (!botGame || botGame.board[index] !== null || botGame.turn !== 'X') return;
        botGame.board[index] = 'X';

        if (checkWin(botGame.board, 'X')) {
            return socket.emit('bot_game_over', { board: botGame.board, resultText: '🎉 تبریک! شما ربات را شکست دادید!' });
        }
        if (botGame.board.every(c => c !== null)) {
            return socket.emit('bot_game_over', { board: botGame.board, resultText: '🤝 بازی مساوی شد!' });
        }

        botGame.turn = 'O';
        setTimeout(() => {
            const botIdx = getBotMove(botGame.board, botGame.difficulty);
            if (botIdx !== -1) {
                botGame.board[botIdx] = 'O';
                if (checkWin(botGame.board, 'O')) {
                    socket.emit('bot_game_over', { board: botGame.board, resultText: '🤖 ربات برنده شد! دوباره تلاش کنید.' });
                } else if (botGame.board.every(c => c !== null)) {
                    socket.emit('bot_game_over', { board: botGame.board, resultText: '🤝 بازی مساوی شد!' });
                } else {
                    botGame.turn = 'X';
                    socket.emit('bot_game_update', { board: botGame.board });
                }
            }
        }, 400);
    });
});

function startTurnTimer(roomId) {
    clearRoomTimer(roomId);
    gameTimers[roomId] = setTimeout(() => {
        const room = activeRooms[roomId];
        if (!room) return;

        const emptyIndexes = room.board.map((val, idx) => val === null ? idx : null).filter(val => val !== null);
        if (emptyIndexes.length > 0) {
            const randomIdx = emptyIndexes[Math.floor(Math.random() * emptyIndexes.length)];
            const symbol = room.symbols[room.turn];
            room.board[randomIdx] = symbol;

            if (checkWin(room.board, symbol)) {
                clearRoomTimer(roomId);
                const winnerSocketId = room.turn;
                const winnerName = room.players[winnerSocketId];
                users[winnerName].coins += 80;
                users[winnerName].trophies += 5;

                io.to(roomId).emit('game_over', {
                    board: room.board,
                    isDraw: false,
                    winnerName: `${winnerName} (ثبت خودکار به دلیل اتمام زمان)`
                });
                delete activeRooms[roomId];
                broadcastLeaderboard();
                return;
            }

            if (room.board.every(c => c !== null)) {
                clearRoomTimer(roomId);
                io.to(roomId).emit('game_over', { board: room.board, isDraw: true, winnerName: null });
                delete activeRooms[roomId];
                return;
            }

            const playerIds = Object.keys(room.players);
            room.turn = playerIds.find(id => id !== room.turn);

            io.to(roomId).emit('update_board', {
                board: room.board,
                turn: room.turn
            });

            startTurnTimer(roomId);
        }
    }, 30000);
}

function clearRoomTimer(roomId) {
    if (gameTimers[roomId]) {
        clearTimeout(gameTimers[roomId]);
        delete gameTimers[roomId];
    }
}

function handleGameOverBySurrender(roomId, socketId) {
    const room = activeRooms[roomId];
    if (!room) return;
    clearRoomTimer(roomId);

    const winnerSocketId = Object.keys(room.players).find(id => id !== socketId);
    if (winnerSocketId) {
        const winnerName = room.players[winnerSocketId];
        users[winnerName].coins += 80;
        users[winnerName].trophies += 5;

        io.to(roomId).emit('game_over', {
            board: room.board,
            isDraw: false,
            winnerName: `${winnerName} (به دلیل خروج حریف)`
        });
        updateUserStatsDirect(winnerSocketId, users[winnerName]);
        broadcastLeaderboard();
    }
    delete activeRooms[roomId];
}

function checkWin(b, s) {
    const wins = [
        [0,1,2],[3,4,5],[6,7,8],
        [0,3,6],[1,4,7],[2,5,8],
        [0,4,8],[2,4,6]
    ];
    return wins.some(([x,y,z]) => b[x] === s && b[y] === s && b[z] === s);
}

function getBotMove(board, diff) {
    const empty = board.map((v, i) => v === null ? i : null).filter(v => v !== null);
    if (empty.length === 0) return -1;
    return empty[Math.floor(Math.random() * empty.length)];
}

function broadcastLeaderboard() {
    const sorted = Object.values(users).sort((a, b) => b.trophies - a.trophies).slice(0, 10);
    io.emit('update_leaderboard', sorted);
}

function broadcastUserList() {
    io.emit('update_user_list', Object.values(users));
}

function updateUserStatsDirect(socketId, userObj) {
    io.to(socketId).emit('update_stats', userObj);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
