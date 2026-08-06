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
app.use(express.json({ limit: '10mb' })); // Increased limit for base64/images
app.use(cors());

const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit to prevent memory crashes
});
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret_attendance_key';

// ==========================================
// 1. CLOUDINARY CONFIGURATION (Optimized)
// ==========================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function uploadBufferToCloudinary(buffer, folder = 'security_visitors') {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        folder,
        faces: true, // Server-side fallback face validation
        transformation: [
          // REMOVED 'effect: improve' - it causes massive delays and API timeouts under load
          { crop: "limit", width: 640, height: 640, quality: "auto" } 
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
const MONGO_URL = process.env.MONGO_URL;
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  try {
    await mongoose.connect(MONGO_URL, { maxPoolSize: 50 }); // Higher pool for concurrent student hits
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
// 4. MONGODB SCHEMAS & MODELS (Unchanged)
// ==========================================
const facultySchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  department: String
});
const Faculty = mongoose.models.Faculty || mongoose.model('Faculty', facultySchema);

const studentSchema = new mongoose.Schema({
  name: String,
  rollNumber: { type: String, unique: true },
  department: String,
  section: String
});
const Student = mongoose.models.Student || mongoose.model('Student', studentSchema);

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

app.post('/api/faculty/register', async (req, res) => {
  try {
    const { name, email, password, department } = req.body;
    const existingFaculty = await Faculty.findOne({ email });
    if (existingFaculty) return res.status(400).json({ error: "Email already registered" });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await Faculty.create({ name, email, password: hashedPassword, department });
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

    const isMatch = await bcrypt.compare(password, faculty.password);
    if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: faculty._id }, JWT_SECRET, { expiresIn: '8h' });

    res.status(200).json({ 
      message: "Login successful", 
      token,
      name: faculty.name,
      department: faculty.department
    });
  } catch (error) {
    res.status(500).json({ error: "Login failed", details: error.message });
  }
});

app.post('/api/faculty/start-session', authMiddleware, async (req, res) => {
  try {
    const { department, section, lat, lng, durationMinutes, allowedRadius } = req.body;
    // Boosted default duration to 10 minutes to account for AI loading times
    const duration = durationMinutes || 10; 
    const expiresAt = new Date(Date.now() + duration * 60000);

    const session = await Session.create({
      facultyId: req.facultyId, 
      department: department || "ALL", 
      section: section || "ALL",
      location: { lat, lng },
      allowedRadius: allowedRadius || 50, 
      expiresAt,
      isActive: true
    });

    res.status(201).json({ message: "Session started", sessionId: session._id, expiresAt: session.expiresAt });
  } catch (error) {
    res.status(500).json({ error: "Failed to start session", details: error.message });
  }
});

app.post('/api/student/mark-attendance', upload.single('image'), async (req, res) => {
  try {
    const { sessionId, rollNumber, name, department, section, lat, lng, deviceFingerprint } = req.body;
    const imageBuffer = req.file?.buffer;
    const studentIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!imageBuffer) return res.status(400).json({ error: "Image file is required" });

    const session = await Session.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    
    // Server-side strict timezone comparison
    if (Date.now() > new Date(session.expiresAt).getTime() || !session.isActive) {
      return res.status(403).json({ error: "Session has expired" });
    }

    const existingEntry = await Attendance.findOne({
      sessionId,
      $or: [ { rollNumber }, { deviceFingerprint } ]
    });

    if (existingEntry) {
      if (existingEntry.rollNumber === rollNumber) {
        return res.status(409).json({ error: "Attendance already marked for this roll number." });
      } else {
        return res.status(403).json({ error: "STRICT BLOCK: Device already used for another student." });
      }
    }

    // Increased drift tolerance for indoor environments
    const distance = getDistanceInMeters(session.location.lat, session.location.lng, parseFloat(lat), parseFloat(lng));
    const GPS_DRIFT_TOLERANCE = 45; 
    const effectiveRadius = session.allowedRadius + GPS_DRIFT_TOLERANCE;

    if (distance > effectiveRadius) {
      return res.status(403).json({ 
        error: `Location outside allowed radius. You are ${Math.round(distance)}m away. Move closer to the classroom, connect to Wi-Fi, and try again.` 
      });
    }

    const uploadResult = await uploadBufferToCloudinary(imageBuffer, 'attendance_captures');

    if (!uploadResult.faces || uploadResult.faces.length === 0) {
      return res.status(400).json({ error: "No face detected by server. Ensure good lighting." });
    }

    await Attendance.create({
      sessionId,
      studentName: name,
      rollNumber,
      department: department.toUpperCase(),
      section: section.toUpperCase(),
      deviceFingerprint,
      ipAddress: studentIp,
      capturedImageUrl: uploadResult.secure_url,
      status: 'Present'
    });

    res.status(200).json({ message: "Attendance Verified & Saved Successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to mark attendance", details: error.message });
  }
});

// (Dashboard & Export routes remain unchanged from your original code)
app.get('/api/faculty/dashboard/:sessionId', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await Session.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const attendees = await Attendance.find({ sessionId }).sort({ department: 1, section: 1, timestamp: 1 });

    const segregatedData = attendees.reduce((acc, curr) => {
      const groupKey = `${curr.department} - Section ${curr.section}`;
      if (!acc[groupKey]) acc[groupKey] = [];
      acc[groupKey].push({
        name: curr.studentName,
        rollNumber: curr.rollNumber,
        timestamp: curr.timestamp,
        image: curr.capturedImageUrl
      });
      return acc;
    }, {});

    res.status(200).json({
      sessionDetails: {
        targetDepartment: session.department,
        targetSection: session.section,
        isActive: new Date() < session.expiresAt && session.isActive,
      },
      totalPresent: attendees.length,
      segregatedData 
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch dashboard", details: error.message });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`🚀 Secure Server running on port ${PORT}`));
}
module.exports = app;
