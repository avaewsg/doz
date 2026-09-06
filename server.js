const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_FILE = path.join(DATA_DIR, 'database.json');

let db = { users: {} };
let globalChat = [];

if (fs.existsSync(DB_FILE)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.log('خطا در خواندن دیتابیس، ایجاد فایل جدید');
    }
}

function saveDB() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
        console.log('خطا در ذخیره دیتابیس:', e);
    }
}

// پاکسازی خودکار چت عمومی هر ۳ ساعت
setInterval(() => {
    globalChat = [];
    io.emit('global_chat_cleared', 'پاکسازی چت انجام شد؛ تاریخچه پیام‌ها ریست شد.');
}, 3 * 60 * 60 * 1000);

let waitingPlayers = [];
const activeGames = {};
const botGames = {};

io.on('connection', (socket) => {
    console.log('کاربر متصل شد:', socket.id);

    socket.on('register', ({ username, password }) => {
        if (!username || !password) {
            return socket.emit('error_msg', 'لطفاً نام کاربری و رمز عبور را وارد کنید');
        }
        username = username.trim();

        if (db.users[username]) {
            return socket.emit('error_msg', 'این نام کاربری قبلاً ثبت شده است! لطفاً وارد شوید.');
        }

        if (username === 'Kiarash' && password !== 'kia12') {
            return socket.emit('error_msg', 'رمز عبور اکانت رسمی مالک اشتباه است!');
        }

        db.users[username] = {
            username,
            password,
            coins: 40,
            trophies: 0,
            isOwner: (username === 'Kiarash'),
            socketId: socket.id
        };

        saveDB();
        socket.data.username = username;
        socket.emit('init_data', getPublicUserData(db.users[username]), db.users[username].isOwner);
        broadcastLeaderboard();
        broadcastUserList();
        sendRecentGlobalChat(socket);
    });

    socket.on('login', ({ username, password }) => {
        if (!username || !password) {
            return socket.emit('error_msg', 'لطفاً نام کاربری و رمز عبور را وارد کنید');
        }
        username = username.trim();

        if (!db.users[username]) {
            return socket.emit('error_msg', 'این نام کاربری وجود ندارد! ابتدا ثبت‌نام کنید.');
        }

        if (db.users[username].password !== password) {
            return socket.emit('error_msg', 'رمز عبور اشتباه است!');
        }

        if (username === 'Kiarash') {
            db.users[username].isOwner = true;
        }

        db.users[username].socketId = socket.id;
        saveDB();

        socket.data.username = username;
        socket.emit('init_data', getPublicUserData(db.users[username]), db.users[username].isOwner);
        broadcastLeaderboard();
        broadcastUserList();
        sendRecentGlobalChat(socket);
    });

    socket.on('send_global_chat', (message) => {
        const username = socket.data.username;
        if (!username || !db.users[username]) return;
        const isOwner = db.users[username].isOwner;

        const chatObj = { username, message, isOwner, timestamp: Date.now() };
        globalChat.push(chatObj);
        if (globalChat.length > 200) globalChat.shift();
        io.emit('receive_global_chat', chatObj);
    });

    // --- بازی نقطه خط با ربات (شبکه 3 در 3 نقطه یعنی 2 در 2 مربع) ---
    socket.on('start_bot_game', ({ difficulty }) => {
        const username = socket.data.username;
        if (!username || !db.users[username]) return;

        // خطوط افقی: 2 رک، هر کدام 3 خط -> کلاً 6 خط افقی
        // خطوط عمودی: 3 ستون، هر کدام 2 خط -> کلاً 6 خط عمودی
        botGames[socket.id] = {
            hLines: Array(6).fill(false),
            vLines: Array(6).fill(false),
            boxes: Array(4).fill(null), // 4 مربع (0 تا 3)
            scores: { player: 0, bot: 0 },
            turn: 'player',
            difficulty: difficulty || 'medium'
        };

        socket.emit('bot_game_start', getDotGameState(socket.id));
    });

    socket.on('make_bot_move', ({ type, index }) => {
        const game = botGames[socket.id];
        if (!game || game.turn !== 'player') return;

        let isValid = false;
        if (type === 'h' && index >= 0 && index < 6 && !game.hLines[index]) {
            game.hLines[index] = true;
            isValid = true;
        } else if (type === 'v' && index >= 0 && index < 6 && !game.vLines[index]) {
            game.vLines[index] = true;
            isValid = true;
        }

        if (!isValid) return;

        // بررسی اینکه آیا این حرکت مربعی را کامل کرده است یا خیر
        let scoredBoxes = checkAndClaimBoxes(game, 'player');

        let isGameOver = game.boxes.every(b => b !== null);

        if (isGameOver) {
            handleDotGameOver(socket, game);
            return;
        }

        // اگر بازیکن مربعی کامل کرد، دوباره نوبت خودش است، وگرنه نوبت ربات می‌شود
        if (scoredBoxes === 0) {
            game.turn = 'bot';
            socket.emit('bot_game_update', getDotGameState(socket.id));
            setTimeout(() => {
                if (!botGames[socket.id]) return;
                makeDotAIMove(socket);
            }, 700);
        } else {
            socket.emit('bot_game_update', getDotGameState(socket.id));
        }
    });

    function makeDotAIMove(socket) {
        const game = botGames[socket.id];
        if (!game || game.turn !== 'bot') return;

        // جمع‌آوری تمام خطوط خالی
        const emptyMoves = [];
        for (let i = 0; i < 6; i++) {
            if (!game.hLines[i]) emptyMoves.push({ type: 'h', index: i });
            if (!game.vLines[i]) emptyMoves.push({ type: 'v', index: i });
        }

        if (emptyMoves.length === 0) return;

        // هوش مصنوعی ساده/متوسط برای انتخاب خط
        let chosenMove = emptyMoves[Math.floor(Math.random() * emptyMoves.length)];
        
        // اعمال حرکت ربات
        if (chosenMove.type === 'h') game.hLines[chosenMove.index] = true;
        else game.vLines[chosenMove.index] = true;

        let scoredBoxes = checkAndClaimBoxes(game, 'bot');
        let isGameOver = game.boxes.every(b => b !== null);

        if (isGameOver) {
            handleDotGameOver(socket, game);
            return;
        }

        if (scoredBoxes > 0 && !isGameOver) {
            // اگر ربات مربع گرفت، باز هم نوبت خودش است
            socket.emit('bot_game_update', getDotGameState(socket.id));
            setTimeout(() => {
                if (!botGames[socket.id]) return;
                makeDotAIMove(socket);
            }, 700);
        } else {
            game.turn = 'player';
            socket.emit('bot_game_update', getDotGameState(socket.id));
        }
    }

    function checkAndClaimBoxes(game, owner) {
        let scored = 0;
        // ۴ مربع در شبکه 2x2 داریم:
        // مربع 0: افقی بالا 0، افقی پایین 3، عمودی چپ 0، عمودی راست 1
        // مربع 1: افقی بالا 1، افقی پایین 4، عمودی چپ 1، عمودی راست 2
        // مربع 2: افقی بالا 3، افقی پایین 5، عمودی چپ 3، عمودی راست 4
        // مربع 3: افقی بالا 4، افقی پایین 5، عمودی چپ 4، عمودی راست 5
        const boxMap = [
            { hTop: 0, hBot: 3, vLeft: 0, vRight: 1 },
            { hTop: 1, hBot: 4, vLeft: 1, vRight: 2 },
            { hTop: 3, hBot: 5, vLeft: 3, vRight: 4 },
            { hTop: 4, hBot: 5, vLeft: 4, vRight: 5 }
        ];

        for (let i = 0; i < 4; i++) {
            if (game.boxes[i] === null) {
                const b = boxMap[i];
                if (game.hLines[b.hTop] && game.hLines[b.hBot] && game.vLines[b.vLeft] && game.vLines[b.vRight]) {
                    game.boxes[i] = owner;
                    game.scores[owner]++;
                    scored++;
                }
            }
        }
        return scored;
    }

    function getDotGameState(socketId) {
        const game = botGames[socketId];
        return {
            hLines: game.hLines,
            vLines: game.vLines,
            boxes: game.boxes,
            scores: game.scores,
            turn: game.turn
        };
    }

    function handleDotGameOver(socket, game) {
        let resultText = '';
        if (game.scores.player > game.scores.bot) {
            resultText = 'تبریک! شما ربات را در بازی نقطه خط بردید 🎉';
        } else if (game.scores.bot > game.scores.player) {
            resultText = 'ربات برنده بازی نقطه خط شد! 🤖';
        } else {
            resultText = 'بازی نقطه خط مساوی شد! 🤝';
        }

        socket.emit('bot_game_over', {
            state: getDotGameState(socket.id),
            resultText
        });
        delete botGames[socket.id];
    }

    // بخش آنلاین
    socket.on('find_game', () => {
        const username = socket.data.username;
        if (!username || !db.users[username]) return;
        const player = db.users[username];

        if (waitingPlayers.includes(socket.id)) return;

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

        while (waitingPlayers.length > 0) {
            const opponentSocketId = waitingPlayers.shift();
            const opponentSocket = io.sockets.sockets.get(opponentSocketId);
            
            if (opponentSocketId !== socket.id && opponentSocket) {
                const opponentUsername = opponentSocket.data.username;
                if (opponentUsername && db.users[opponentUsername]) {
                    const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                    
                    activeGames[roomId] = {
                        players: [socket.id, opponentSocketId],
                        usernames: [username, opponentUsername],
                        board: Array(9).fill(null),
                        turn: socket.id,
                        scores: { [socket.id]: 0, [opponentSocketId]: 0 },
                        currentRound: 1,
                        maxRounds: 3,
                        timeouts: { [socket.id]: 0, [opponentSocketId]: 0 },
                        timer: null
                    };

                    socket.join(roomId);
                    opponentSocket.join(roomId);

                    io.to(roomId).emit('game_start', {
                        roomId,
                        players: { [socket.id]: username, [opponentSocketId]: opponentUsername },
                        symbols: { [socket.id]: 'X', [opponentSocketId]: 'O' },
                        turn: socket.id,
                        turnName: username,
                        scores: { [socket.id]: 0, [opponentSocketId]: 0 },
                        round: 1,
                        timeLeft: 30
                    });

                    startTurnTimer(roomId);
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

    socket.on('surrender_game', ({ roomId }) => {
        if (activeGames[roomId]) {
            handleGameOverBySurrender(roomId, socket.id);
        }
    });

    socket.on('make_move', ({ roomId, index }) => {
        processMove(roomId, socket.id, index);
    });

    socket.on('send_chat', ({ roomId, message }) => {
        const username = socket.data.username;
        if (!username || !db.users[username]) return;
        const isOwner = db.users[username].isOwner;
        io.to(roomId).emit('receive_chat', { username, message, isOwner });
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

        if (botGames[socket.id]) delete botGames[socket.id];

        for (const roomId in activeGames) {
            const game = activeGames[roomId];
            if (game.players.includes(socket.id)) {
                if (game.timer) clearTimeout(game.timer);
                const winnerSocketId = game.players.find(id => id !== socket.id);
                handleGameOverByDisconnect(roomId, winnerSocketId);
                break;
            }
        }
    });
});

function sendRecentGlobalChat(socket) {
    const fifteenMinutesAgo = Date.now() - (15 * 60 * 1000);
    const recentMessages = globalChat.filter(msg => msg.timestamp >= fifteenMinutesAgo);
    socket.emit('init_global_chat', recentMessages);
}

function startTurnTimer(roomId) {
    const game = activeGames[roomId];
    if (!game) return;
    if (game.timer) clearTimeout(game.timer);

    game.timer = setTimeout(() => {
        const currentTurnSocketId = game.turn;
        game.timeouts[currentTurnSocketId] = (game.timeouts[currentTurnSocketId] || 0) + 1;

        if (game.timeouts[currentTurnSocketId] >= 2) {
            const winnerSocketId = game.players.find(id => id !== currentTurnSocketId);
            handleFinalMatchOver(roomId, winnerSocketId, 'عدم پاسخگویی حریف');
        } else {
            const emptyCells = [];
            game.board.forEach((val, idx) => { if (val === null) emptyCells.push(idx); });

            if (emptyCells.length > 0) {
                const randomCell = emptyCells[Math.floor(Math.random() * emptyCells.length)];
                io.to(roomId).emit('chat_system_alert', 'تایمر بازیکن تمام شد و یک خانه به صورت خودکار انتخاب شد!');
                processMove(roomId, currentTurnSocketId, randomCell);
            }
        }
    }, 30000);
}

function processMove(roomId, socketId, index) {
    const game = activeGames[roomId];
    if (!game || game.turn !== socketId) return;
    if (game.board[index] !== null) return;
    if (game.timer) clearTimeout(game.timer);

    const symbol = game.players[0] === socketId ? 'X' : 'O';
    game.board[index] = symbol;

    const winnerSymbol = checkWin(game.board);
    const p1Socket = game.players[0];
    const p2Socket = game.players[1];
    const u1 = game.usernames[0];
    const u2 = game.usernames[1];

    if (winnerSymbol || game.board.every(cell => cell !== null)) {
        let roundWinnerId = null;
        if (winnerSymbol) {
            roundWinnerId = (winnerSymbol === 'X') ? p1Socket : p2Socket;
            game.scores[roundWinnerId]++;
        }

        const isMatchEnded = game.currentRound >= game.maxRounds || 
                             game.scores[p1Socket] >= 2 || 
                             game.scores[p2Socket] >= 2;

        if (isMatchEnded) {
            let finalWinnerId = null;
            if (game.scores[p1Socket] > game.scores[p2Socket]) finalWinnerId = p1Socket;
            else if (game.scores[p2Socket] > game.scores[p1Socket]) finalWinnerId = p2Socket;

            if (finalWinnerId) {
                const loserSocketId = finalWinnerId === p1Socket ? p2Socket : p1Socket;
                const winnerUser = db.users[finalWinnerId === p1Socket ? u1 : u2];
                const loserUser = db.users[loserSocketId === p1Socket ? u1 : u2];

                winnerUser.coins += 80;
                winnerUser.trophies += 40;
                if (!loserUser.isOwner) {
                    loserUser.trophies = Math.max(0, loserUser.trophies - 10);
                }
                saveDB();

                io.to(roomId).emit('match_over', {
                    board: game.board,
                    scores: game.scores,
                    winnerName: winnerUser.username,
                    isDraw: false
                });
            } else {
                const user1 = db.users[u1];
                const user2 = db.users[u2];
                if (!user1.isOwner) user1.coins += 10;
                if (!user2.isOwner) user2.coins += 10;
                saveDB();

                io.to(roomId).emit('match_over', {
                    board: game.board,
                    scores: game.scores,
                    winnerName: 'مساوی کل مسابقه (برگشت سکه‌ها)!',
                    isDraw: true
                });
            }

            io.to(p1Socket).emit('update_stats', getPublicUserData(db.users[u1]));
            io.to(p2Socket).emit('update_stats', getPublicUserData(db.users[u2]));
            broadcastLeaderboard();
            delete activeGames[roomId];
        } else {
            io.to(roomId).emit('round_over', {
                board: game.board,
                scores: game.scores,
                roundWinner: roundWinnerId ? db.users[roundWinnerId === p1Socket ? u1 : u2].username : 'مساوی این راند'
            });

            setTimeout(() => {
                if (!activeGames[roomId]) return;
                game.currentRound++;
                game.board = Array(9).fill(null);
                game.turn = game.players[(game.currentRound - 1) % 2];
                
                const currentTurnName = game.turn === p1Socket ? u1 : u2;

                io.to(roomId).emit('next_round', {
                    board: game.board,
                    turn: game.turn,
                    turnName: currentTurnName,
                    scores: game.scores,
                    round: game.currentRound,
                    timeLeft: 30
                });
                startTurnTimer(roomId);
            }, 2500);
        }
    } else {
        game.turn = game.players.find(id => id !== socketId);
        const nextTurnName = game.turn === p1Socket ? u1 : u2;
        io.to(roomId).emit('update_board', { 
            board: game.board, 
            turn: game.turn, 
            turnName: nextTurnName,
            scores: game.scores,
            timeLeft: 30 
        });
        startTurnTimer(roomId);
    }
}

function handleFinalMatchOver(roomId, winnerSocketId, reason) {
    const game = activeGames[roomId];
    if (!game) return;
    if (game.timer) clearTimeout(game.timer);

    const p1Socket = game.players[0];
    const p2Socket = game.players[1];
    const u1 = game.usernames[0];
    const u2 = game.usernames[1];

    const winnerUser = db.users[winnerSocketId === p1Socket ? u1 : u2];
    const loserSocketId = game.players.find(id => id !== winnerSocketId);
    const loserUser = db.users[loserSocketId === p1Socket ? u1 : u2];

    winnerUser.coins += 80;
    winnerUser.trophies += 40;
    if (!loserUser.isOwner) {
        loserUser.trophies = Math.max(0, loserUser.trophies - 10);
    }
    saveDB();

    io.to(roomId).emit('match_over', {
        board: game.board,
        scores: game.scores,
        winnerName: `${winnerUser.username} (${reason})`,
        isDraw: false
    });

    io.to(p1Socket).emit('update_stats', getPublicUserData(db.users[u1]));
    io.to(p2Socket).emit('update_stats', getPublicUserData(db.users[u2]));
    broadcastLeaderboard();
    delete activeGames[roomId];
}

function handleGameOverBySurrender(roomId, loserSocketId) {
    const winnerSocketId = activeGames[roomId].players.find(id => id !== loserSocketId);
    handleFinalMatchOver(roomId, winnerSocketId, 'تسلیم حریف');
}

function handleGameOverByDisconnect(roomId, winnerSocketId) {
    handleFinalMatchOver(roomId, winnerSocketId, 'قطع ارتباط حریف');
}

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
        isOwner: u.isOwner,
        trophies: u.trophies
    }));
    io.emit('update_user_list', allUsers);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`سرور DozX روی پورت ${PORT} اجرا شد`));
