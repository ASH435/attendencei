import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // Mock office location (e.g., somewhere in San Francisco)
  const OFFICE_LOCATION = {
    lat: 37.7749,
    lng: -122.4194,
    radius: 50 // meters
  };

  function getDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371e3; // metres
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // in metres
  }

  // API routes
  app.post("/api/verify-attendance", async (req, res) => {
    const { lat, lng, type, userId, photo } = req.body;

    if (!lat || !lng || !type || !userId || !photo) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const distance = getDistance(lat, lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);

    if (distance > OFFICE_LOCATION.radius) {
      return res.status(403).json({ 
        error: "Geofencing failed. You must be within 50 meters of the office.",
        distance: Math.round(distance)
      });
    }

    // Generate server-side timestamp
    const timestamp = new Date().toISOString();

    // In a real app, we would verify the Firebase Auth token here
    // and then save to Firestore using the Admin SDK.
    // For this demo, we'll return the verified data to the client
    // so the client can save it to Firestore (since we have client-side Firestore setup).
    
    res.json({
      success: true,
      timestamp,
      verified: true
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
