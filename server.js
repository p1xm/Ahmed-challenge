const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY' });

mongoose.connect('mongodb://localhost:27017/quiz_duel_db', {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('✅ تم الاتصال بقاعدة البيانات بنجاح'))
.catch(err => console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err));

const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    phone: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    userId: { type: String, unique: true, required: true },
    profilePic: { type: String, default: 'default.png' },
    bio: { type: String, maxlength: 15 },
    totalScore: { type: Number, default: 0 },
    friends: [{ type: String }]
});
const User = mongoose.model('User', userSchema);

const challengeSchema = new mongoose.Schema({
    challengerId: String,
    opponentId: String,
    questions: Array,
    scores: {
        challengerScore: { type: Number, default: 0 },
        opponentScore: { type: Number, default: 0 }
    },
    status: { type: String, default: 'active' }
});
const Challenge = mongoose.model('Challenge', challengeSchema);

// مسار تسجيل حساب جديد مع كود الأصدقاء AY2009
app.post('/api/register', async (req, res) => {
    try {
        const { username, phone, password, bio, inviteCode } = req.body;
        
        const SECRET_FRIEND_CODE = "AY2009"; 

        if (inviteCode !== SECRET_FRIEND_CODE) {
            return res.status(400).json({ error: '❌ كود الأصدقاء غير صحيح! الكود المعتمد هو AY2009.' });
        }

        const existingUser = await User.findOne({ phone });
        if (existingUser) {
            return res.status(400).json({ error: 'رقم الهاتف هذا مسجل بالفعل بحساب آخر!' });
        }

        let randomId;
        let userExists = true;
        while (userExists) {
            randomId = 'USER-' + Math.floor(1000 + Math.random() * 9000);
            const check = await User.findOne({ userId: randomId });
            if (!check) userExists = false;
        }

        const newUser = new User({
            username,
            phone,
            password,
            userId: randomId,
            bio: bio ? bio.substring(0, 15) : ''
        });

        await newUser.save();
        res.status(201).json({ message: 'تم إنشاء الحساب بنجاح', user: newUser });
    } catch (err) {
        res.status(500).json({ error: 'خطأ أثناء التسجيل: ' + err.message });
    }
});

// مسار تسجيل الدخول من أي جهاز
app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const user = await User.findOne({ phone });
        if (!user) {
            return res.status(404).json({ error: 'رقم الهاتف غير مسجل لدينا!' });
        }
        if (user.password !== password) {
            return res.status(401).json({ error: 'الرقم السري غير صحيح!' });
        }
        res.json({ message: 'تم تسجيل الدخول بنجاح', user });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في السيرفر: ' + err.message });
    }
});

app.post('/api/add-friend', async (req, res) => {
    try {
        const { myId, friendId } = req.body;
        if (myId === friendId) {
            return res.status(400).json({ error: 'لا يمكنك إضافة نفسك صديقاً!' });
        }
        const friend = await User.findOne({ userId: friendId });
        if (!friend) return res.status(404).json({ error: 'الصديق غير موجود بهذا الـ ID' });
        
        const me = await User.findOne({ userId: myId });
        if (me.friends.includes(friendId)) {
            return res.status(400).json({ error: 'هذا الصديق مضاف مسبقاً في قائمتك' });
        }

        me.friends.push(friendId);
        await me.save();
        res.json({ message: 'تم إضافة الصديق بنجاح!', friends: me.friends });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/create-challenge', upload.single('lessonFile'), async (req, res) => {
    try {
        const { challengerId, opponentId, numQuestions } = req.body;
        if (!req.file) {
            return res.status(400).json({ error: 'يرجى إرفاق ملف الدرس' });
        }

        let fileText = '';
        if (req.file.mimetype === 'application/pdf') {
            const pdfData = await pdfParse(req.file.buffer);
            fileText = pdfData.text;
        } else {
            fileText = req.file.buffer.toString('utf8');
        }

        const prompt = `
        بناءً على محتوى الدرس التالي، قم بتوليد ${numQuestions || 5} أسئلة اختيار من متعدد (MCQ).
        أريد النتيجة بصيغة JSON صارمة جداً عبارة عن مصفوفة (Array) من الكائنات بالشكل التالي من دون أي كود إضافي:
        [
          {
            "question": "نص السؤال؟",
            "options": ["اختيار 1", "اختيار 2", "اختيار 3", "اختيار 4"],
            "correctAnswer": "الإجابة الصحيحة تماماً كما وردت في الاختيارات"
          }
        ]

        محتوى الدرس:
        ${fileText.substring(0, 7000)}
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });

        let aiText = response.text.trim().replace(/```json/g, '').replace(/```/g, '').trim();
        const questionsArray = JSON.parse(aiText);

        const newChallenge = new Challenge({
            challengerId,
            opponentId,
            questions: questionsArray,
            status: 'active'
        });

        await newChallenge.save();
        res.status(201).json({
            message: 'تم بدء التحدي بنجاح!',
            challengeId: newChallenge._id,
            questions: questionsArray
        });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في توليد الأسئلة: ' + err.message });
    }
});

io.on('connection', (socket) => {
    socket.on('join_challenge', (challengeId) => {
        socket.join(challengeId);
    });

    socket.on('submit_answer', async (data) => {
        const { challengeId, userId, score } = data;
        try {
            const challenge = await Challenge.findById(challengeId);
            if (challenge) {
                if (challenge.challengerId === userId) {
                    challenge.scores.challengerScore = score;
                } else if (challenge.opponentId === userId) {
                    challenge.scores.opponentScore = score;
                }
                await challenge.save();
            }
        } catch (e) {
            console.error('خطأ في تحديث النتيجة:', e);
        }
        socket.to(challengeId).emit('opponent_progress', { userId, score });
    });

    socket.on('freeze_opponent', (data) => {
        const { challengeId } = data;
        socket.to(challengeId).emit('you_are_frozen');
    });
});

server.listen(3000, () => {
    console.log('🚀 السيرفر يعمل بكفاءة على البورت 3000');
});