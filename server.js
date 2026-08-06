require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const cors = require('cors');
const multer = require('multer');
const excelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); 

const app = express();
app.use(express.json());
app.use(cors());

const upload = multer();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret_attendance_key';

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
      { 
        folder,
        faces: true, 
        transformation: [
          { effect: "improve" },        
          { effect: "brightness:30" },  
          { crop: "limit", width: 600, height: 600 } // Reduced slightly for faster processing
        ]
      },
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
// 3. SECURITY MIDDLEWARE
// ==========================================
const authMiddleware = (req, res, next) => {
  const authHeader = req.header('Authorization');
  if (!authHeader) return res.status(401).json({ error: "Access Denied: No token provided" });

  const token = authHeader.split(' ')[1];
  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.facultyId = verified.id; 
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

// ==========================================
// 4. MONGODB SCHEMAS & MODELS
// ==========================================
const facultySchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  department: String
});
const Faculty = mongoose.models.Faculty || mongoose.model('Faculty', facultySchema);

const sessionSchema = new mongoose.Schema({
  facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty' },
  department: { type: String, required: true }, 
  section: { type: String, required: true },    
  location: { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
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
  department: String, 
  section: String,    
  deviceFingerprint: String,
  ipAddress: String,  
  capturedImageUrl: String,
  timestamp: { type: Date, default: Date.now },
  status: { type: String, enum: ['Present', 'Denied'], default: 'Present' }
});
// Add compound index to prevent duplicate submissions faster at DB level
attendanceSchema.index({ sessionId: 1, rollNumber: 1 }, { unique: true });
const Attendance = mongoose.models.Attendance || mongoose.model('Attendance', attendanceSchema);

// ==========================================
// 5. GPS MATH HELPER FUNCTION
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
// 6. API ROUTES
// ==========================================
app.post('/api/faculty/register', async (req, res) => { /* unchanged */ });
app.post('/api/faculty/login', async (req, res) => { /* unchanged */ });

app.post('/api/faculty/start-session', authMiddleware, async (req, res) => {
  try {
    const { department, section, lat, lng, durationMinutes, allowedRadius } = req.body;
    const expiresAt = new Date(Date.now() + (durationMinutes || 5) * 60000);

    const session = await Session.create({
      facultyId: req.facultyId, 
      department: department || "ALL", 
      section: section || "ALL",
      location: { lat, lng },
      allowedRadius: allowedRadius || 50, 
      expiresAt,
      isActive: true
    });

    res.status(201).json({ message: "Session started successfully", sessionId: session._id, expiresAt: session.expiresAt });
  } catch (error) {
    res.status(500).json({ error: "Failed to start session", details: error.message });
  }
});

// --- STUDENT: Mark Attendance ---
app.post('/api/student/mark-attendance', upload.single('image'), async (req, res) => {
  try {
    const { sessionId, rollNumber, name, department, section, lat, lng, deviceFingerprint } = req.body;
    const imageBuffer = req.file?.buffer;
    const studentIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!imageBuffer) return res.status(400).json({ error: "Image file is required" });

    // 1. Session Validations
    const session = await Session.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    
    // FIX: Add a 60-second grace period for network latency and clock drift
    const gracePeriodMs = 60 * 1000; 
    const isExpired = new Date().getTime() > (new Date(session.expiresAt).getTime() + gracePeriodMs);
    
    if (isExpired || !session.isActive) {
      return res.status(403).json({ error: "Session has expired" });
    }

    // 2. Strict Multiple Submissions Block
    const existingEntry = await Attendance.findOne({
      sessionId,
      $or: [ { rollNumber }, { deviceFingerprint } ]
    });

    if (existingEntry) {
      if (existingEntry.rollNumber === rollNumber) {
        return res.status(409).json({ error: "Attendance already marked for this roll number." });
      } else {
        return res.status(403).json({ error: "STRICT BLOCK: This device has already been used to mark attendance for someone else." });
      }
    }

    // 3. GPS Radius Validation
    const distance = getDistanceInMeters(session.location.lat, session.location.lng, parseFloat(lat), parseFloat(lng));
    
    // Configurable Indoor Drift Tolerance
    const GPS_DRIFT_TOLERANCE = 50; 
    const effectiveRadius = session.allowedRadius + GPS_DRIFT_TOLERANCE;

    if (distance > effectiveRadius) {
      return res.status(403).json({ 
        error: `Access Denied: You are ${Math.round(distance)}m away. Maximum allowed range (including indoor drift buffer) is ${effectiveRadius}m.` 
      });
    }

    // 4. Cloudinary Upload
    const uploadResult = await uploadBufferToCloudinary(imageBuffer, 'attendance_captures');

    if (!uploadResult.faces || uploadResult.faces.length === 0) {
      return res.status(400).json({ error: "No face detected. Please ensure good lighting." });
    }
    if (uploadResult.faces.length > 1) {
      return res.status(400).json({ error: "Multiple faces detected. Only you should be in the frame." });
    }

    // 5. Save Verified Data
    await Attendance.create({
      sessionId, studentName: name, rollNumber, department: department.toUpperCase(),
      section: section.toUpperCase(), deviceFingerprint, ipAddress: studentIp,
      capturedImageUrl: uploadResult.secure_url, status: 'Present'
    });

    res.status(200).json({ message: "Attendance Verified & Saved Successfully" });
  } catch (error) {
    console.error(error);
    if (error.code === 11000) {
       return res.status(409).json({ error: "Attendance already marked (duplicate entry detected)." });
    }
    res.status(500).json({ error: "Failed to mark attendance", details: error.message });
  }
});

app.get('/api/faculty/dashboard/:sessionId', authMiddleware, async (req, res) => { /* unchanged */ });
app.get('/api/faculty/export-excel/:sessionId', authMiddleware, async (req, res) => { /* unchanged */ });

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`🚀 Secure Server running on port ${PORT}`));
}
module.exports = app;
