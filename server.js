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
const dotsBotGames = {}; // حالت بازی نقطه خط با ربات

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

    socket.on('start_bot_game', ({ difficulty }) => {
        const username = socket.data.username;
        if (!username || !db.users[username]) return;

        botGames[socket.id] = {
            board: Array(9).fill(null),
            turn: 'player',
            difficulty: difficulty || 'medium'
        };

        socket.emit('bot_game_start', { board: botGames[socket.id].board, turn: 'player' });
    });

    socket.on('make_bot_move', ({ index }) => {
        const game = botGames[socket.id];
        if (!game || game.turn !== 'player' || game.board[index] !== null) return;

        game.board[index] = 'X';
        let winner = checkWin(game.board);
        if (winner || game.board.every(c => c !== null)) {
            handleBotGameOver(socket, game, winner);
        } else {
            game.turn = 'bot';
            socket.emit('bot_game_update', { board: game.board, turn: 'bot' });
            setTimeout(() => {
                if (!botGames[socket.id]) return;
                makeBotAIMove(socket, game);
            }, 600);
        }
    });

    function makeBotAIMove(socket, game) {
        const emptyCells = [];
        game.board.forEach((val, idx) => { if (val === null) emptyCells.push(idx); });
        if (emptyCells.length === 0) return;

        let chosenMove = null;
        if (game.difficulty === 'easy') {
            chosenMove = emptyCells[Math.floor(Math.random() * emptyCells.length)];
        } else if (game.difficulty === 'medium') {
            chosenMove = findBestMove(game.board, 'O', 'X');
            if (chosenMove === null) {
                const preferred = [4, 0, 2, 6, 8, 1, 3, 5, 7].filter(i => game.board[i] === null);
                chosenMove = preferred.length > 0 ? preferred[0] : emptyCells[0];
            }
        } else {
            chosenMove = findBestMove(game.board, 'O', 'X');
            if (chosenMove === null) chosenMove = emptyCells[Math.floor(Math.random() * emptyCells.length)];
        }

        game.board[chosenMove] = 'O';
        let winner = checkWin(game.board);
        if (winner || game.board.every(c => c !== null)) {
            handleBotGameOver(socket, game, winner);
        } else {
            game.turn = 'player';
            socket.emit('bot_game_update', { board: game.board, turn: 'player' });
        }
    }

    function findBestMove(board, botSym, playerSym) {
        for (let i = 0; i < 9; i++) {
            if (board[i] === null) {
                board[i] = botSym;
                if (checkWin(board) === botSym) { board[i] = null; return i; }
                board[i] = null;
            }
        }
        for (let i = 0; i < 9; i++) {
            if (board[i] === null) {
                board[i] = playerSym;
                if (checkWin(board) === playerSym) { board[i] = null; return i; }
                board[i] = null;
            }
        }
        return null;
    }

    function handleBotGameOver(socket, game, winnerSymbol) {
        let resultText = '';
        if (winnerSymbol === 'X') resultText = 'تبریک! شما ربات را بردید 🎉 (بدون تغییر کاپ/سکه)';
        else if (winnerSymbol === 'O') resultText = 'ربات برنده شد! 🤖 (بدون تغییر کاپ/سکه)';
        else resultText = 'بازی مساوی شد! (بدون تغییر کاپ/سکه)';

        socket.emit('bot_game_over', { board: game.board, resultText });
        delete botGames[socket.id];
    }

    // ==================== بخش بازی نقطه خط با ربات ====================
    // شبکه 7 در 7 نقطه یعنی 6 ردیف در 6 ستون مربع شکل = 36 مربع کامل (بزرگ‌تر از 35)
    const DOTS_ROWS = 7;
    const DOTS_COLS = 7;

    socket.on('start_dots_bot_game', () => {
        const username = socket.data.username;
        if (!username || !db.users[username]) return;

        // تعداد کل خطوط افقی: ROWS * (COLS - 1)
        // تعداد کل خطوط عمودی: COLS * (ROWS - 1)
        const hLines = Array(DOTS_ROWS * (DOTS_COLS - 1)).fill(false);
        const vLines = Array(DOTS_COLS * (DOTS_ROWS - 1)).fill(false);
        const boxes = Array((DOTS_ROWS - 1) * (DOTS_COLS - 1)).fill(null); // null یا 'player' یا 'bot'

        dotsBotGames[socket.id] = {
            hLines,
            vLines,
            boxes,
            turn: 'player',
            scores: { player: 0, bot: 0 }
        };

        socket.emit('dots_bot_game_start', {
            hLines,
            vLines,
            boxes,
            turn: 'player',
            scores: { player: 0, bot: 0 },
            rows: DOTS_ROWS,
            cols: DOTS_COLS
        });
    });

    socket.on('make_dots_bot_move', ({ type, index }) => {
        const game = dotsBotGames[socket.id];
        if (!game || game.turn !== 'player') return;

        let lineArray = (type === 'h') ? game.hLines : game.vLines;
        if (index < 0 || index >= lineArray.length || lineArray[index]) return;

        lineArray[index] = true;

        // بررسی اینکه آیا این خط مربعی را کامل کرده است یا خیر
        let boxesCompleted = checkAndCompleteDotsBoxes(game, type, index, 'player');

        let totalBoxes = game.boxes.length;
        let filledCount = game.scores.player + game.scores.bot;

        if (filledCount >= totalBoxes) {
            handleDotsBotGameOver(socket, game);
            return;
        }

        if (boxesCompleted > 0) {
            // بازیکن دوباره نوبت دارد چون مربع کامل کرده است
            socket.emit('dots_bot_game_update', {
                hLines: game.hLines,
                vLines: game.vLines,
                boxes: game.boxes,
                turn: 'player',
                scores: game.scores,
                message: 'یک مربع ساختی! دوباره نوبت توست.'
            });
        } else {
            // نوبت ربات
            game.turn = 'bot';
            socket.emit('dots_bot_game_update', {
                hLines: game.hLines,
                vLines: game.vLines,
                boxes: game.boxes,
                turn: 'bot',
                scores: game.scores,
                message: 'نوبت ربات است...'
            });

            setTimeout(() => {
                if (!dotsBotGames[socket.id]) return;
                makeDotsBotAIMove(socket, game);
            }, 700);
        }
    });

    function makeDotsBotAIMove(socket, game) {
        let totalBoxes = game.boxes.length;
        let filledCount = game.scores.player + game.scores.bot;
        if (filledCount >= totalBoxes) {
            handleDotsBotGameOver(socket, game);
            return;
        }

        // هوش مصنوعی ساده و هوشمند برای انتخاب خط خالی
        let availableHLines = [];
        game.hLines.forEach((val, idx) => { if (!val) availableHLines.push({ type: 'h', index: idx }); });
        let availableVLines = [];
        game.vLines.forEach((val, idx) => { if (!val) availableVLines.push({ type: 'v', index: idx }); });

        let allAvailable = [...availableHLines, ...availableVLines];
        if (allAvailable.length === 0) {
            handleDotsBotGameOver(socket, game);
            return;
        }

        // اولویت اول ربات: اگر حرکتی وجود دارد که بلافاصله مربعی را کامل کند، آن را انتخاب کند
        let chosenLine = null;
        for (let line of allAvailable) {
            let tempHLines = [...game.hLines];
            let tempVLines = [...game.vLines];
            if (line.type === 'h') tempHLines[line.index] = true;
            else tempVLines[line.index] = true;

            if (countCompletedBoxesSimulate(tempHLines, tempVLines, game.boxes) > game.scores.bot + game.scores.player) {
                chosenLine = line;
                break;
            }
        }

        // اگر حرکتی برای تکمیل مربع نبود، یک حرکت تصادفی انتخاب کند
        if (!chosenLine) {
            chosenLine = allAvailable[Math.floor(Math.random() * allAvailable.length)];
        }

        let lineArray = (chosenLine.type === 'h') ? game.hLines : game.vLines;
        lineArray[chosenLine.index] = true;

        let boxesCompleted = checkAndCompleteDotsBoxes(game, chosenLine.type, chosenLine.index, 'bot');

        filledCount = game.scores.player + game.scores.bot;
        if (filledCount >= totalBoxes) {
            handleDotsBotGameOver(socket, game);
            return;
        }

        if (boxesCompleted > 0) {
            socket.emit('dots_bot_game_update', {
                hLines: game.hLines,
                vLines: game.vLines,
                boxes: game.boxes,
                turn: 'bot',
                scores: game.scores,
                message: 'ربات یک مربع ساخت و دوباره نوبت اوست!'
            });
            setTimeout(() => {
                if (!dotsBotGames[socket.id]) return;
                makeDotsBotAIMove(socket, game);
            }, 700);
        } else {
            game.turn = 'player';
            socket.emit('dots_bot_game_update', {
                hLines: game.hLines,
                vLines: game.vLines,
                boxes: game.boxes,
                turn: 'player',
                scores: game.scores,
                message: 'نوبت شماست!'
            });
        }
    }

    function checkAndCompleteDotsBoxes(game, type, index, owner) {
        let completed = 0;
        let R = DOTS_ROWS - 1;
        let C = DOTS_COLS - 1;

        for (let r = 0; r < R; r++) {
            for (let c = 0; c < C; c++) {
                let boxIndex = r * C + c;
                if (game.boxes[boxIndex] !== null) continue;

                // ایندکس 4 ضلع مربع (r, c)
                // خط افقی بالا: r * C + c
                // خط افقی پایین: (r + 1) * C + c
                // خط عمودی چپ: c * R + r (در ساختار آرایه vLines) -> بگذارید دقیق محاسبه کنیم:
                // آرایه vLines با ابعاد DOTS_COLS * (DOTS_ROWS - 1) است.
                // فرمول ایندکس خط عمودی برای ستون c و سطر r: c * (DOTS_ROWS - 1) + r
                let topH = r * C + c;
                let bottomH = (r + 1) * C + c;
                let leftV = c * (DOTS_ROWS - 1) + r;
                let rightV = (c + 1) * (DOTS_ROWS - 1) + r;

                if (game.hLines[topH] && game.hLines[bottomH] && game.vLines[leftV] && game.vLines[rightV]) {
                    game.boxes[boxIndex] = owner;
                    game.scores[owner]++;
                    completed++;
                }
            }
        }
        return completed;
    }

    function countCompletedBoxesSimulate(hLines, vLines, oldBoxes) {
        let count = 0;
        let R = DOTS_ROWS - 1;
        let C = DOTS_COLS - 1;
        for (let r = 0; r < R; r++) {
            for (let c = 0; c < C; c++) {
                let boxIndex = r * C + c;
                let topH = r * C + c;
                let bottomH = (r + 1) * C + c;
                let leftV = c * (DOTS_ROWS - 1) + r;
                let rightV = (c + 1) * (DOTS_ROWS - 1) + r;
                if (hLines[topH] && hLines[bottomH] && vLines[leftV] && vLines[rightV]) {
                    count++;
                }
            }
        }
        return count;
    }

    function handleDotsBotGameOver(socket, game) {
        let resultText = '';
        if (game.scores.player > game.scores.bot) {
            resultText = `تبریک! شما برنده شدید 🎉 (امتیاز شما: ${game.scores.player} - امتیاز ربات: ${game.scores.bot})`;
        } else if (game.scores.bot > game.scores.player) {
            resultText = `ربات برنده شد! 🤖 (امتیاز ربات: ${game.scores.bot} - امتیاز شما: ${game.scores.player})`;
        } else {
            resultText = `بازی مساوی شد! 🤝 (هر دو ${game.scores.player} امتیاز)`;
        }

        socket.emit('dots_bot_game_over', {
            hLines: game.hLines,
            vLines: game.vLines,
            boxes: game.boxes,
            scores: game.scores,
            resultText
        });
        delete dotsBotGames[socket.id];
    }
    // ==================== پایان بخش نقطه خط ====================

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
        if (dotsBotGames[socket.id]) delete dotsBotGames[socket.id];

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
