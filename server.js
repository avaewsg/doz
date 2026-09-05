const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// تنظیم مسیر دیتابیس برای پشتیبانی از ولوم رایلی (/data) یا لوکال
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_FILE = path.join(DATA_DIR, 'database.json');

let db = { users: {} };

// بارگذاری پایگاه داده از روی دیسک
if (fs.existsSync(DB_FILE)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.log('خطا در خواندن دیتابیس، ایجاد فایل جدید');
    }
}

function saveDB() {
    try {
        // اگر پوشه /data وجود نداشت (حالت لوکال)، مشکلی نیست ولی روی رایلی پوشه وجود دارد
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
        console.log('خطا در ذخیره دیتابیس:', e);
    }
}

let waitingPlayers = [];
const activeGames = {};

io.on('connection', (socket) => {
    console.log('کاربر متصل شد:', socket.id);

    socket.on('auth', ({ username, password }) => {
        username = username.trim();
        if (!username || !password) {
            return socket.emit('error_msg', 'لطفاً نام کاربری و رمز عبور را وارد کنید');
        }

        if (username === 'Kiarash') {
            if (password !== 'kia12') {
                return socket.emit('error_msg', 'رمز عبور مالک اشتباه است!');
            }
        }

        if (db.users[username]) {
            if (db.users[username].password !== password) {
                return socket.emit('error_msg', 'رمز عبور اشتباه است!');
            }
            db.users[username].socketId = socket.id;
        } else {
            db.users[username] = {
                username,
                password,
                coins: 40,
                trophies: 0,
                isOwner: (username === 'Kiarash'),
                socketId: socket.id
            };
        }

        saveDB();
        socket.data.username = username;
        socket.emit('init_data', getPublicUserData(db.users[username]), db.users[username].isOwner);
        broadcastLeaderboard();
        broadcastUserList();
    });

    socket.on('find_game', () => {
        const username = socket.data.username;
        if (!username || !db.users[username]) return;
        const player = db.users[username];

        if (!player.isOwner) {
            if (player.coins < 10) {
                socket.emit('error_msg', 'سکه‌های شما برای ورود کافی نیست (حداقل ۱۰ سکه)');
                return;
            }
            player.coins -= 10;
            saveDB();
            socket.emit('update_stats', getPublicUserData(player));
            broadcastLeaderboard();
        }

        if (waitingPlayers.includes(socket.id)) return;

        while (waitingPlayers.length > 0) {
            const opponentSocketId = waitingPlayers.shift();
            const opponentSocket = io.sockets.sockets.get(opponentSocketId);
            
            if (opponentSocketId !== socket.id && opponentSocket) {
                const opponentUsername = opponentSocket.data.username;
                if (opponentUsername && db.users[opponentUsername]) {
                    const roomId = `room_${Date.now()}`;
                    
                    activeGames[roomId] = {
                        players: [socket.id, opponentSocketId],
                        usernames: [username, opponentUsername],
                        board: Array(9).fill(null),
                        turn: socket.id
                    };

                    socket.join(roomId);
                    opponentSocket.join(roomId);

                    io.to(roomId).emit('game_start', {
                        roomId,
                        players: {
                            [socket.id]: username,
                            [opponentSocketId]: opponentUsername
                        },
                        turn: socket.id
                    });
                    return;
                }
            }
        }

        waitingPlayers.push(socket.id);
        socket.emit('waiting_for_opponent');
    });

    socket.on('cancel_search', () => {
        const index = waitingPlayers.indexOf(socket.id);
        if (index !== -1) {
            waitingPlayers.splice(index, 1);
            const username = socket.data.username;
            if (username && db.users[username] && !db.users[username].isOwner) {
                db.users[username].coins += 10;
                saveDB();
                socket.emit('update_stats', getPublicUserData(db.users[username]));
                broadcastLeaderboard();
            }
            socket.emit('search_cancelled');
        }
    });

    socket.on('make_move', ({ roomId, index }) => {
        const game = activeGames[roomId];
        if (!game || game.turn !== socket.id) return;
        if (game.board[index] !== null) return;

        const symbol = game.players[0] === socket.id ? 'X' : 'O';
        game.board[index] = symbol;

        const winnerSymbol = checkWin(game.board);
        
        if (winnerSymbol || game.board.every(cell => cell !== null)) {
            let finalWinnerSocket = null;
            const p1Socket = game.players[0];
            const p2Socket = game.players[1];
            const u1 = game.usernames[0];
            const u2 = game.usernames[1];

            if (winnerSymbol) {
                finalWinnerSocket = (winnerSymbol === 'X') ? p1Socket : p2Socket;
            }

            if (finalWinnerSocket) {
                const loserSocket = finalWinnerSocket === p1Socket ? p2Socket : p1Socket;
                const winnerUser = db.users[finalWinnerSocket === p1Socket ? u1 : u2];
                const loserUser = db.users[loserSocket === p1Socket ? u1 : u2];
                
                winnerUser.coins += 80;
                winnerUser.trophies += 40;
                if (!loserUser.isOwner) {
                    loserUser.trophies = Math.max(0, loserUser.trophies - 10);
                }
                saveDB();

                io.to(roomId).emit('game_over', {
                    board: game.board,
                    winnerName: winnerUser.username,
                    isDraw: false
                });

                io.to(p1Socket).emit('update_stats', getPublicUserData(db.users[u1]));
                io.to(p2Socket).emit('update_stats', getPublicUserData(db.users[u2]));
                broadcastLeaderboard();
                delete activeGames[roomId];
            } else {
                // مساوی شدن و برگشت سکه‌ها
                const user1 = db.users[u1];
                const user2 = db.users[u2];

                if (!user1.isOwner) user1.coins += 10;
                if (!user2.isOwner) user2.coins += 10;
                saveDB();

                io.to(roomId).emit('game_over', {
                    board: game.board,
                    winnerName: 'مساوی (برگشت سکه‌ها)!',
                    isDraw: true
                });

                io.to(p1Socket).emit('update_stats', getPublicUserData(user1));
                io.to(p2Socket).emit('update_stats', getPublicUserData(user2));
                broadcastLeaderboard();
                delete activeGames[roomId];
            }
        } else {
            game.turn = game.players.find(id => id !== socket.id);
            io.to(roomId).emit('update_board', { board: game.board, turn: game.turn });
        }
    });

    socket.on('send_chat', ({ roomId, message }) => {
        const username = socket.data.username;
        if (!username) return;
        io.to(roomId).emit('receive_chat', { username, message });
    });

    socket.on('admin_set_coins', ({ targetUsername, newCoins }) => {
        const adminUsername = socket.data.username;
        if (!adminUsername || !db.users[adminUsername]?.isOwner) return;

        if (db.users[targetUsername]) {
            db.users[targetUsername].coins = parseInt(newCoins) || 0;
            saveDB();
            broadcastLeaderboard();
            broadcastUserList();
            
            const targetSocketId = db.users[targetUsername].socketId;
            if (targetSocketId) {
                io.to(targetSocketId).emit('update_stats', getPublicUserData(db.users[targetUsername]));
            }
        }
    });

    socket.on('disconnect', () => {
        const index = waitingPlayers.indexOf(socket.id);
        if (index !== -1) waitingPlayers.splice(index, 1);
    });
});

function checkWin(b) {
    const lines = [
        [0,1,2], [3,4,5], [6,7,8],
        [0,3,6], [1,4,7], [2,5,8],
        [0,4,8], [2,4,6]
    ];
    for (let l of lines) {
        if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) {
            return b[l[0]];
        }
    }
    return null;
}

function getPublicUserData(user) {
    return {
        username: user.username,
        coins: user.isOwner ? 'بی‌نهایت ♾️' : user.coins,
        rawCoins: user.coins,
        trophies: user.trophies,
        isOwner: user.isOwner
    };
}

function broadcastLeaderboard() {
    const allUsers = Object.values(db.users);
    allUsers.sort((a, b) => b.trophies - a.trophies);
    const top10 = allUsers.slice(0, 10).map(u => ({
        username: u.username,
        trophies: u.trophies,
        isOwner: u.isOwner
    }));
    io.emit('update_leaderboard', top10);
}

function broadcastUserList() {
    const allUsers = Object.values(db.users).map(u => ({
        username: u.username,
        coins: u.coins,
        isOwner: u.isOwner
    }));
    io.emit('update_user_list', allUsers);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`سرور DozX روی پورت ${PORT} اجرا شد`));
