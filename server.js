require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const cors = require('cors');
const multer = require('multer');
const excelJS = require('exceljs');
const bcrypt = require('bcryptjs'); // Added bcryptjs for auth
 
const app = express();
app.use(express.json());
app.use(cors());

// Use Multer to handle file uploads in memory
const upload = multer();

// ==========================================
// 1. CLOUDINARY CONFIGURATION
// ==========================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dppiuypop",
  api_key: process.env.CLOUDINARY_API_KEY || "412712715735329",
  api_secret: process.env.CLOUDINARY_API_SECRET || "m04IUY0-awwtr4YoS-1xvxOOIzU",
});

function uploadBufferToCloudinary(buffer, folder = 'security_visitors') {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

// ==========================================
// 2. MONGODB CONNECTION
// ==========================================
const MONGO_URL = process.env.MONGO_URL || 'mongodb+srv://abc:1234@cluster0.nnjwt12.mongodb.net/security';
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  try {
    await mongoose.connect(MONGO_URL);
    isConnected = true;
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    throw err;
  }
}

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    return res.status(500).json({ error: "Database connection failed" });
  }
});

// ==========================================
// 3. MONGODB SCHEMAS & MODELS
// ==========================================
const facultySchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }, // Will store bcrypt hash
  department: String
});
const Faculty = mongoose.models.Faculty || mongoose.model('Faculty', facultySchema);

const studentSchema = new mongoose.Schema({
  name: String,
  rollNumber: { type: String, unique: true },
  department: String,
  section: String,
  faceEmbedding: [Number] 
});
const Student = mongoose.models.Student || mongoose.model('Student', studentSchema);

const sessionSchema = new mongoose.Schema({
  facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty' },
  department: String,
  section: String,
  location: { 
    lat: { type: Number, required: true }, 
    lng: { type: Number, required: true } 
  },
  allowedRadius: { type: Number, required: true },
  startTime: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  isActive: { type: Boolean, default: true }
});
const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

const attendanceSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
  studentName: String,
  rollNumber: String,
  deviceFingerprint: String,
  capturedImageUrl: String,
  timestamp: { type: Date, default: Date.now },
  status: { type: String, enum: ['Present', 'Denied'], default: 'Present' }
});
const Attendance = mongoose.models.Attendance || mongoose.model('Attendance', attendanceSchema);

// ==========================================
// 4. HELPER FUNCTIONS
// ==========================================
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const toRadians = (deg) => deg * (Math.PI / 180);
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; 
}

// ==========================================
// 5. API ROUTES
// ==========================================

// --- FACULTY AUTHENTICATION ---
app.post('/api/faculty/register', async (req, res) => {
  try {
    const { name, email, password, department } = req.body;

    const existingFaculty = await Faculty.findOne({ email });
    if (existingFaculty) return res.status(400).json({ error: "Email already registered" });

    // Hash the password using bcryptjs
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newFaculty = await Faculty.create({
      name,
      email,
      password: hashedPassword,
      department
    });

    res.status(201).json({ message: "Registration successful" });
  } catch (error) {
    res.status(500).json({ error: "Registration failed", details: error.message });
  }
});

app.post('/api/faculty/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const faculty = await Faculty.findOne({ email });
    if (!faculty) return res.status(404).json({ error: "Faculty not found" });

    // Compare provided password with stored hash
    const isMatch = await bcrypt.compare(password, faculty.password);
    if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

    res.status(200).json({ 
      message: "Login successful", 
      facultyId: faculty._id,
      name: faculty.name,
      department: faculty.department
    });
  } catch (error) {
    res.status(500).json({ error: "Login failed", details: error.message });
  }
});


// --- FACULTY: Start an Attendance Session ---
app.post('/api/faculty/start-session', async (req, res) => {
  try {
    const { facultyId, department, section, lat, lng, durationMinutes, allowedRadius } = req.body;

    const finalDuration = durationMinutes || 5; 
    const finalRadius = allowedRadius || 50;    
    const expiresAt = new Date(Date.now() + finalDuration * 60000);

    const session = await Session.create({
      facultyId,
      department,
      section,
      location: { lat, lng },
      allowedRadius: finalRadius, 
      expiresAt,
      isActive: true
    });

    res.status(201).json({
      message: "Session started successfully",
      sessionId: session._id,
      expiresAt: session.expiresAt,
      allowedRadius: session.allowedRadius
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to start session", details: error.message });
  }
});

// --- STUDENT: Mark Attendance ---
app.post('/api/student/mark-attendance', upload.single('image'), async (req, res) => {
  try {
    const { sessionId, rollNumber, name, lat, lng, deviceFingerprint } = req.body;
    const imageBuffer = req.file?.buffer;

    if (!imageBuffer) return res.status(400).json({ error: "Image file is required" });

    const session = await Session.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (new Date() > session.expiresAt || !session.isActive) {
      return res.status(403).json({ error: "Session has expired or is inactive" });
    }

    const studentLat = parseFloat(lat);
    const studentLng = parseFloat(lng);
    const distance = getDistanceInMeters(session.location.lat, session.location.lng, studentLat, studentLng);

    if (distance > session.allowedRadius) {
      return res.status(403).json({ 
        error: `Access Denied: You are ${Math.round(distance)} meters away. Must be within ${session.allowedRadius} meters.`, 
        distance 
      });
    }

    const existingDevice = await Attendance.findOne({ sessionId, deviceFingerprint });
    if (existingDevice) {
      return res.status(403).json({ error: "Access Denied: Device already used for attendance in this session" });
    }

    const existingRoll = await Attendance.findOne({ sessionId, rollNumber });
    if (existingRoll) {
      return res.status(409).json({ error: "Already marked: Attendance exists for this roll number" });
    }

    const uploadResult = await uploadBufferToCloudinary(imageBuffer, 'attendance_captures');

    const attendanceRecord = await Attendance.create({
      sessionId,
      studentName: name,
      rollNumber,
      deviceFingerprint,
      capturedImageUrl: uploadResult.secure_url,
      status: 'Present'
    });

    res.status(200).json({ message: "Attendance Saved Successfully", attendance: attendanceRecord });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to mark attendance", details: error.message });
  }
});

// --- FACULTY: View Dashboard (Live Attendance) ---
app.get('/api/faculty/dashboard/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const attendees = await Attendance.find({ sessionId }).sort({ timestamp: 1 });
    const session = await Session.findById(sessionId);

    if (!session) return res.status(404).json({ error: "Session not found" });

    res.status(200).json({
      sessionDetails: {
        department: session.department,
        section: session.section,
        isActive: new Date() < session.expiresAt && session.isActive,
        allowedRadius: session.allowedRadius
      },
      totalPresent: attendees.length,
      students: attendees.map(a => ({
        name: a.studentName,
        rollNumber: a.rollNumber,
        timestamp: a.timestamp,
        image: a.capturedImageUrl
      }))
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch dashboard", details: error.message });
  }
});

// --- FACULTY: Export Attendance to Excel ---
app.get('/api/faculty/export-excel/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await Session.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const attendees = await Attendance.find({ sessionId }).sort({ timestamp: 1 });
    const workbook = new excelJS.Workbook();
    const worksheet = workbook.addWorksheet('Attendance Log');

    worksheet.columns = [
      { header: 'S.No', key: 'sno', width: 10 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Roll Number', key: 'rollNumber', width: 20 },
      { header: 'Date', key: 'date', width: 15 },
      { header: 'Time', key: 'time', width: 15 },
      { header: 'Status', key: 'status', width: 15 }
    ];

    worksheet.getRow(1).eachCell((cell) => { cell.font = { bold: true }; });

    attendees.forEach((attendee, index) => {
      const attendanceDate = new Date(attendee.timestamp);
      worksheet.addRow({
        sno: index + 1,
        name: attendee.studentName,
        rollNumber: attendee.rollNumber,
        date: attendanceDate.toLocaleDateString(),
        time: attendanceDate.toLocaleTimeString(), 
        status: attendee.status
      });
    });

    const fileName = `${session.department || 'Dept'}_${session.section || 'Sec'}_Attendance.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ error: "Failed to export Excel sheet", details: error.message });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}
module.exports = app;
