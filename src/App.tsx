/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, Component, type ReactNode, type ErrorInfo } from 'react';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  limit, 
  onSnapshot,
  Timestamp,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from 'firebase/firestore';
import { 
  onAuthStateChanged, 
  signOut,
  User as FirebaseUser
} from 'firebase/auth';
import { db, auth } from './firebase';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Camera, 
  MapPin, 
  Clock, 
  History, 
  LogOut, 
  CheckCircle2, 
  AlertCircle,
  ChevronRight,
  User as UserIcon,
  Loader2,
  X,
  Smartphone,
  Check
} from 'lucide-react';
import { cn } from './lib/utils';

// --- Types ---
interface AttendanceRecord {
  id?: string;
  userId: string;
  timestamp: Timestamp;
  type: 'check-in' | 'check-out';
  location: { lat: number; lng: number };
  photoUrl: string;
}

interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  role: 'employee' | 'admin';
  initials: string;
}

// --- Constants ---
const OFFICE_LOCATION = {
  lat: 28.6139,
  lng: 77.2090,
  radius: 50 // meters
};

const HOLD_DURATION_MS = 2000;

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

// --- Components ---

const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'glass' }>(
  ({ className, variant = 'primary', ...props }, ref) => {
    const variants = {
      primary: 'bg-primary text-white hover:bg-primary-dark shadow-lg',
      secondary: 'glass text-white hover:bg-white/20',
      glass: 'btn-glass text-white'
    };
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center rounded-xl px-8 py-4 text-sm font-medium transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
          variants[variant],
          className
        )}
        {...props}
      />
    );
  }
);

// --- Error Boundary ---
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  state = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen flex-col items-center justify-center p-6 text-center text-white">
          <AlertCircle className="mb-4 h-12 w-12 text-red-400" />
          <h2 className="mb-2 text-xl font-bold">Something went wrong</h2>
          <p className="mb-6 opacity-70">{this.state.error?.message}</p>
          <Button onClick={() => window.location.reload()}>Reload App</Button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AttendanceApp />
    </ErrorBoundary>
  );
}

function AttendanceApp() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [procStep, setProcStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [serverTime, setServerTime] = useState(new Date());
  const [view, setView] = useState<'dashboard' | 'history'>('dashboard');
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [pin, setPin] = useState(['', '', '', '']);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const holdTimerRef = useRef<number | null>(null);
  const [holdProgress, setHoldProgress] = useState(0);

  // --- Auth & Data Fetching ---
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        let userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
        if (userDoc.exists()) {
          setProfile(userDoc.data() as UserProfile);
        } else {
          const newProfile: UserProfile = {
            uid: firebaseUser.uid,
            displayName: firebaseUser.displayName || 'User',
            email: firebaseUser.email || '',
            role: 'employee',
            initials: (firebaseUser.displayName || 'U').split(' ').map(n => n[0]).join('').toUpperCase()
          };
          await setDoc(doc(db, 'users', firebaseUser.uid), newProfile);
          setProfile(newProfile);
        }

        const q = query(
          collection(db, 'attendance'),
          where('userId', '==', firebaseUser.uid),
          orderBy('timestamp', 'desc'),
          limit(50)
        );
        const unsubscribeRecords = onSnapshot(q, (snapshot) => {
          setRecords(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AttendanceRecord)));
        });
        return () => unsubscribeRecords();
      }
      setLoading(false);
    });
    return () => unsubscribeAuth();
  }, []);

  // --- Clock ---
  useEffect(() => {
    const timer = setInterval(() => setServerTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // --- Location ---
  useEffect(() => {
    if ("geolocation" in navigator) {
      navigator.geolocation.watchPosition(
        (pos) => setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => setError("Location services required"),
        { enableHighAccuracy: true }
      );
    }
  }, []);

  // --- PIN Login ---
  const handlePinChange = (index: number, value: string) => {
    if (value.length > 1) value = value.slice(-1);
    const newPin = [...pin];
    newPin[index] = value;
    setPin(newPin);

    if (value && index < 3) {
      const nextInput = document.getElementById(`pin-${index + 1}`);
      nextInput?.focus();
    }

    if (newPin.every(d => d !== '')) {
      if (newPin.join('') === '1234') {
        setIsLoggedIn(true);
      } else {
        setPin(['', '', '', '']);
        document.getElementById('pin-0')?.focus();
        setError("Invalid PIN");
        setTimeout(() => setError(null), 2000);
      }
    }
  };

  // --- Camera ---
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setShowCamera(true);
      }
    } catch (err) {
      setError("Camera access required");
    }
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const context = canvasRef.current.getContext('2d');
      if (context) {
        canvasRef.current.width = videoRef.current.videoWidth;
        canvasRef.current.height = videoRef.current.videoHeight;
        context.drawImage(videoRef.current, 0, 0);
        const photo = canvasRef.current.toDataURL('image/jpeg');
        setCapturedPhoto(photo);
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
        setShowCamera(false);
      }
    }
  };

  // --- Hold to Clock In ---
  const startHold = () => {
    if (!isWithinRange) return;
    const startTime = Date.now();
    holdTimerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / HOLD_DURATION_MS, 1);
      setHoldProgress(progress);
      if (progress >= 1) {
        stopHold();
        if (capturedPhoto) {
          executeAttendance();
        } else {
          startCamera();
        }
      }
    }, 16);
  };

  const stopHold = () => {
    if (holdTimerRef.current) {
      clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setHoldProgress(0);
  };

  // --- Execute Attendance ---
  const executeAttendance = async () => {
    if (!user || !location || !capturedPhoto) return;
    setIsProcessing(true);
    setProcStep(1); // Verifying location

    try {
      await new Promise(r => setTimeout(r, 800));
      const distance = getDistance(location.lat, location.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
      if (distance > OFFICE_LOCATION.radius) throw new Error("Out of range");
      
      setProcStep(2); // Validating photo
      await new Promise(r => setTimeout(r, 600));

      setProcStep(3); // Syncing server time
      await new Promise(r => setTimeout(r, 600));

      setProcStep(4); // Recording attendance
      const type = records[0]?.type === 'check-in' ? 'check-out' : 'check-in';
      await addDoc(collection(db, 'attendance'), {
        userId: user.uid,
        timestamp: serverTimestamp(),
        type,
        location,
        photoUrl: capturedPhoto
      });

      await new Promise(r => setTimeout(r, 800));
      setCapturedPhoto(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsProcessing(false);
      setProcStep(0);
    }
  };

  const lastRecord = records[0];
  const isCheckedIn = lastRecord?.type === 'check-in';
  const distance = location ? getDistance(location.lat, location.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng) : null;
  const isWithinRange = distance !== null && distance <= OFFICE_LOCATION.radius;

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-white opacity-50" />
      </div>
    );
  }

  // --- Login Screen ---
  if (!isLoggedIn) {
    return (
      <div className="flex h-screen flex-col items-center justify-center p-8">
        <motion.div 
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="glass w-full max-w-sm rounded-[32px] p-10 text-center"
        >
          <div className="mx-auto mb-8 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 glass-border">
            <Clock className="h-8 w-8 text-white" />
          </div>
          <h1 className="mb-2 text-3xl font-bold tracking-tight">Kripa Attendance</h1>
          <p className="mb-10 text-sm opacity-60 font-medium">Secure Employee Presence</p>
          
          <div className="space-y-6">
            <p className="text-xs font-bold uppercase tracking-[0.2em] opacity-40">Enter 4-Digit PIN</p>
            <div className="flex justify-center gap-3">
              {pin.map((digit, i) => (
                <input
                  key={i}
                  id={`pin-${i}`}
                  type="password"
                  inputMode="numeric"
                  value={digit}
                  onChange={(e) => handlePinChange(i, e.target.value)}
                  className="h-14 w-14 rounded-xl bg-white/10 text-center text-2xl font-bold glass-border focus:bg-white/20 focus:outline-none transition-all"
                />
              ))}
            </div>
            {error && <p className="text-xs font-bold text-red-400 uppercase tracking-widest">{error}</p>}
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden text-white font-sans">
      {/* --- Top Bar --- */}
      <header className="flex items-center justify-between p-6 pt-12">
        <div className="flex items-center gap-4 cursor-pointer" onClick={() => setIsProfileOpen(true)}>
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 glass-border text-sm font-bold">
            {profile?.initials}
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest opacity-50">Presence</p>
            <p className="text-sm font-bold tracking-tight">{profile?.displayName}</p>
          </div>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 glass-border">
          <MapPin className={cn("h-5 w-5", isWithinRange ? "text-green-400" : "text-red-400")} />
        </div>
      </header>

      {/* --- Tabs --- */}
      <div className="flex px-6 gap-2">
        <button 
          onClick={() => setView('dashboard')}
          className={cn(
            "rounded-full px-5 py-2 text-xs font-bold uppercase tracking-widest transition-all",
            view === 'dashboard' ? "bg-white text-forest" : "text-white/50 hover:text-white"
          )}
        >
          Dashboard
        </button>
        <button 
          onClick={() => setView('history')}
          className={cn(
            "rounded-full px-5 py-2 text-xs font-bold uppercase tracking-widest transition-all",
            view === 'history' ? "bg-white text-forest" : "text-white/50 hover:text-white"
          )}
        >
          History
        </button>
      </div>

      <main className="flex-1 overflow-y-auto px-6 pb-24">
        <AnimatePresence mode="wait">
          {view === 'dashboard' ? (
            <motion.div
              key="dash"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="mt-8 space-y-6"
            >
              {/* --- Clock --- */}
              <div className="py-8 text-center">
                <h2 className="text-7xl font-light tracking-tighter tabular-nums">
                  {format(serverTime, 'HH:mm')}
                </h2>
                <p className="mt-2 text-xs font-bold uppercase tracking-[0.3em] opacity-40">
                  {format(serverTime, 'EEEE, MMMM do')}
                </p>
              </div>

              {/* --- Status --- */}
              <div className="glass rounded-[32px] p-6 flex items-center gap-5">
                <div className={cn(
                  "flex h-14 w-14 items-center justify-center rounded-2xl",
                  isCheckedIn ? "bg-green-400/20 text-green-400" : "bg-white/10 text-white/40"
                )}>
                  <Clock className="h-7 w-7" />
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-40">Status</p>
                  <p className="text-lg font-bold tracking-tight">
                    {isCheckedIn ? "Checked In" : "Off the clock"}
                  </p>
                  {lastRecord && (
                    <p className="text-xs opacity-40">
                      Last: {format(lastRecord.timestamp.toDate(), 'HH:mm')}
                    </p>
                  )}
                </div>
              </div>

              {/* --- Security Badges --- */}
              <div className="grid grid-cols-3 gap-3">
                <div className="glass-dark rounded-2xl p-4 text-center">
                  <MapPin className="mx-auto mb-2 h-5 w-5 opacity-40" />
                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-40">Range</p>
                  <p className={cn("text-[10px] font-bold", isWithinRange ? "text-green-400" : "text-red-400")}>
                    {isWithinRange ? "50m OK" : "OUT"}
                  </p>
                </div>
                <div className="glass-dark rounded-2xl p-4 text-center">
                  <Clock className="mx-auto mb-2 h-5 w-5 opacity-40" />
                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-40">Server</p>
                  <p className="text-[10px] font-bold text-green-400">SYNCED</p>
                </div>
                <div className="glass-dark rounded-2xl p-4 text-center">
                  <Camera className="mx-auto mb-2 h-5 w-5 opacity-40" />
                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-40">Camera</p>
                  <p className="text-[10px] font-bold text-green-400">READY</p>
                </div>
              </div>

              {/* --- Action Button --- */}
              <div className="pt-8 text-center">
                <div className="relative inline-block">
                  <motion.button
                    onMouseDown={startHold}
                    onMouseUp={stopHold}
                    onMouseLeave={stopHold}
                    onTouchStart={startHold}
                    onTouchEnd={stopHold}
                    disabled={!isWithinRange || isProcessing}
                    className={cn(
                      "relative h-44 w-44 rounded-full glass-border text-white transition-all flex flex-col items-center justify-center gap-2",
                      isCheckedIn ? "bg-slate-blue/40" : "bg-primary-glass",
                      (!isWithinRange || isProcessing) && "opacity-20 grayscale"
                    )}
                  >
                    <svg className="absolute inset-0 h-full w-full -rotate-90 scale-[1.05]">
                      <circle
                        cx="88"
                        cy="88"
                        r="84"
                        fill="none"
                        stroke="rgba(255,255,255,0.1)"
                        strokeWidth="4"
                      />
                      <motion.circle
                        cx="88"
                        cy="88"
                        r="84"
                        fill="none"
                        stroke="white"
                        strokeWidth="4"
                        strokeDasharray="528"
                        animate={{ strokeDashoffset: 528 * (1 - holdProgress) }}
                        transition={{ duration: 0 }}
                      />
                    </svg>
                    <div className="z-10 flex flex-col items-center">
                      <Smartphone className="mb-2 h-10 w-10" />
                      <span className="text-[10px] font-bold uppercase tracking-[0.2em]">
                        {isCheckedIn ? "Hold to Out" : "Hold to In"}
                      </span>
                    </div>
                  </motion.button>
                </div>
                <p className="mt-6 text-xs font-medium opacity-40 tracking-wider">
                  Hold for 2 seconds to confirm
                </p>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="mt-8 space-y-4"
            >
              <p className="text-[10px] font-bold uppercase tracking-[0.4em] opacity-40 mb-8">Attendance Archive</p>
              {records.map((record) => (
                <div key={record.id} className="glass-dark rounded-2xl p-5 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      record.type === 'check-in' ? "bg-green-400" : "bg-white/20"
                    )} />
                    <div>
                      <p className="text-sm font-bold tracking-tight">
                        {record.type === 'check-in' ? "Clock In" : "Clock Out"}
                      </p>
                      <p className="text-[10px] font-medium opacity-40 uppercase tracking-widest">
                        {format(record.timestamp.toDate(), 'HH:mm — MMM d, yyyy')}
                      </p>
                    </div>
                  </div>
                  <div className="h-10 w-10 overflow-hidden rounded-lg glass-border">
                    <img src={record.photoUrl} alt="ID" className="h-full w-full object-cover grayscale" />
                  </div>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* --- Camera Overlay --- */}
      <AnimatePresence>
        {showCamera && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black flex flex-col"
          >
            <video ref={videoRef} autoPlay playsInline className="h-full w-full object-cover" />
            <div className="absolute inset-0 flex flex-col">
              <div className="p-8 flex justify-between items-center bg-gradient-to-b from-black/80 to-transparent">
                <span className="text-sm font-bold uppercase tracking-widest">Live Photo Verification</span>
                <button onClick={() => setShowCamera(false)} className="h-10 w-10 glass rounded-full flex items-center justify-center">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="flex-1 flex items-center justify-center">
                <div className="h-[60vh] aspect-[3/4] border-2 border-dashed border-white/20 rounded-[100px]" />
              </div>
              <div className="p-12 pb-16 text-center bg-gradient-to-t from-black/80 to-transparent">
                <button 
                  onClick={capturePhoto}
                  className="h-20 w-20 rounded-full border-4 border-white flex items-center justify-center p-1"
                >
                  <div className="h-full w-full bg-white rounded-full" />
                </button>
                <p className="mt-6 text-xs opacity-60">Ensure face is centered in the frame</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* --- Processing Overlay --- */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] glass-dark flex items-center justify-center p-8"
          >
            <div className="glass w-full max-w-xs rounded-[40px] p-10 text-center">
              <Loader2 className="mx-auto mb-8 h-10 w-10 animate-spin opacity-40" />
              <div className="space-y-4">
                {[
                  "Verifying Location",
                  "Validating ID",
                  "Syncing with Server",
                  "Finalizing Entry"
                ].map((step, i) => (
                  <div key={i} className={cn(
                    "flex items-center gap-3 text-xs font-bold uppercase tracking-widest transition-all",
                    procStep > i ? "text-green-400" : procStep === i + 1 ? "text-white" : "opacity-20"
                  )}>
                    <div className={cn(
                      "h-2 w-2 rounded-full",
                      procStep > i ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]" : "bg-white/20"
                    )} />
                    {step}
                    {procStep > i && <Check className="ml-auto h-3 w-3" />}
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* --- Profile Drawer --- */}
      <AnimatePresence>
        {isProfileOpen && (
          <div className="fixed inset-0 z-50 overflow-hidden">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsProfileOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="absolute right-0 top-0 bottom-0 w-[85%] max-w-sm glass shadow-2xl p-8 pt-20"
            >
              <button onClick={() => setIsProfileOpen(false)} className="absolute top-8 left-8 h-10 w-10 glass rounded-full flex items-center justify-center">
                <X className="h-5 w-5" />
              </button>
              
              <div className="mb-10 text-center">
                <div className="mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-[32px] bg-white/10 glass-border text-3xl font-bold">
                  {profile?.initials}
                </div>
                <h3 className="text-2xl font-bold tracking-tight">{profile?.displayName}</h3>
                <p className="text-sm opacity-40">{profile?.email}</p>
              </div>

              <div className="space-y-1 mb-10">
                <div className="glass-dark rounded-2xl p-4 flex justify-between items-center">
                  <span className="text-[10px] font-bold uppercase tracking-widest opacity-40">Employee ID</span>
                  <span className="text-[10px] font-bold font-mono uppercase tracking-widest">{profile?.uid.slice(0, 8)}</span>
                </div>
                <div className="glass-dark rounded-2xl p-4 flex justify-between items-center">
                  <span className="text-[10px] font-bold uppercase tracking-widest opacity-40">Role</span>
                  <span className="text-[10px] font-bold uppercase tracking-widest">{profile?.role}</span>
                </div>
                <div className="glass-dark rounded-2xl p-4 flex justify-between items-center">
                  <span className="text-[10px] font-bold uppercase tracking-widest opacity-40">Device</span>
                  <span className="text-[10px] font-bold uppercase tracking-widest">Authorized</span>
                </div>
              </div>

              <button 
                onClick={() => { setIsLoggedIn(false); setIsProfileOpen(false); signOut(auth); }}
                className="w-full rounded-2xl py-4 flex items-center justify-center gap-2 text-red-400 font-bold glass-border hover:bg-red-400/10 transition-all"
              >
                <LogOut className="h-4 w-4" />
                <span className="text-[10px] uppercase tracking-widest">Sign Out</span>
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
