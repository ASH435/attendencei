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
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User as FirebaseUser
} from 'firebase/auth';
import { db, auth } from './firebase';
import { format, subDays, differenceInHours } from 'date-fns';
import { motion, AnimatePresence, useMotionValue, useTransform } from 'motion/react';
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
  Loader2
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
}

// --- Constants ---
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

// --- Components ---

const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'outline' | 'ghost' }>(
  ({ className, variant = 'primary', ...props }, ref) => {
    const variants = {
      primary: 'bg-forest text-white hover:bg-primary-dark',
      secondary: 'bg-zinc-50 text-black hover:bg-zinc-100',
      outline: 'border border-zinc-200 bg-transparent hover:bg-zinc-50',
      ghost: 'bg-transparent hover:bg-zinc-50'
    };
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center rounded-sm px-8 py-4 text-xs tracking-[0.2em] uppercase font-bold transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-30',
          variants[variant],
          className
        )}
        {...props}
      />
    );
  }
);

const Card = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn('bg-zinc-50/50 p-8', className)}>
    {children}
  </div>
);

// --- Error Handling ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    tenantId?: string | null;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let message = "Something went wrong.";
      try {
        const parsed = JSON.parse(this.state.error?.message || "");
        if (parsed.error) message = parsed.error;
      } catch (e) {
        message = this.state.error?.message || message;
      }

      return (
        <div className="flex h-screen flex-col items-center justify-center bg-white p-6 text-center">
          <AlertCircle className="mb-4 h-12 w-12 text-red-500" />
          <h2 className="mb-2 text-xl font-bold">Application Error</h2>
          <p className="mb-6 text-zinc-500">{message}</p>
          <Button onClick={() => window.location.reload()}>Reload App</Button>
        </div>
      );
    }

    return (this as any).props.children;
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
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [serverTime, setServerTime] = useState(new Date());
  const [view, setView] = useState<'dashboard' | 'history'>('dashboard');

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // --- Auth & Data Fetching ---
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        // Fetch or create profile
        let userDoc;
        try {
          userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
        } catch (err) {
          handleFirestoreError(err, OperationType.GET, `users/${firebaseUser.uid}`);
          return;
        }

        if (userDoc.exists()) {
          setProfile(userDoc.data() as UserProfile);
        } else {
          const newProfile: UserProfile = {
            uid: firebaseUser.uid,
            displayName: firebaseUser.displayName || 'Anonymous',
            email: firebaseUser.email || '',
            role: 'employee'
          };
          try {
            await setDoc(doc(db, 'users', firebaseUser.uid), newProfile);
          } catch (err) {
            handleFirestoreError(err, OperationType.WRITE, `users/${firebaseUser.uid}`);
          }
          setProfile(newProfile);
        }

        // Fetch records
        const q = query(
          collection(db, 'attendance'),
          where('userId', '==', firebaseUser.uid),
          orderBy('timestamp', 'desc'),
          limit(50)
        );
        const unsubscribeRecords = onSnapshot(q, (snapshot) => {
          setRecords(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AttendanceRecord)));
        }, (err) => {
          handleFirestoreError(err, OperationType.LIST, 'attendance');
        });
        return () => unsubscribeRecords();
      } else {
        setProfile(null);
        setRecords([]);
      }
      setLoading(false);
    });

    return () => unsubscribeAuth();
  }, []);

  // --- Server Time Simulation ---
  useEffect(() => {
    const timer = setInterval(() => setServerTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // --- Geolocation ---
  useEffect(() => {
    if ("geolocation" in navigator) {
      navigator.geolocation.watchPosition(
        (pos) => setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => setError("Please enable location services to check in."),
        { enableHighAccuracy: true }
      );
    }
  }, []);

  // --- Camera Logic ---
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setShowCamera(true);
      }
    } catch (err) {
      setError("Camera access denied. Please enable camera to check in.");
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
        
        // Stop camera
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => track.stop());
        setShowCamera(false);
      }
    }
  };

  // --- Attendance Logic ---
  const handleAttendance = async () => {
    if (!user || !location || !capturedPhoto) return;

    setIsChecking(true);
    setError(null);

    try {
      const type = records[0]?.type === 'check-in' ? 'check-out' : 'check-in';
      
      // Validate geofencing right before Firestore insertion
      const distance = getDistance(location.lat, location.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
      if (distance > OFFICE_LOCATION.radius) {
        throw new Error(`Out of range (${Math.round(distance)}m). Please move closer to the office.`);
      }

      // Save to Firestore
      try {
        await addDoc(collection(db, 'attendance'), {
          userId: user.uid,
          timestamp: serverTimestamp(),
          type,
          location,
          photoUrl: capturedPhoto
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, 'attendance');
      }

      setCapturedPhoto(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsChecking(false);
    }
  };

  const login = () => signInWithPopup(auth, new GoogleAuthProvider());
  const logout = () => signOut(auth);

  const lastRecord = records[0];
  const isCheckedIn = lastRecord?.type === 'check-in';
  
  const distance = location ? getDistance(location.lat, location.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng) : null;
  const isWithinRange = distance !== null && distance <= OFFICE_LOCATION.radius;

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <Loader2 className="h-6 w-6 animate-spin text-forest" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-white p-12 text-center">
        <div className="mb-16">
          <Clock className="h-12 w-12 text-forest mx-auto mb-6" />
          <h1 className="text-4xl font-light tracking-[0.2em] uppercase text-zinc-900 mb-4">Kripa</h1>
          <p className="text-zinc-400 text-xs tracking-widest uppercase">Kripa Attendance System</p>
        </div>
        <Button onClick={login} className="w-full max-w-xs">
          Authenticating with Google
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white font-sans text-black selection:bg-zinc-100">
      {/* --- Header --- */}
      <header className="sticky top-0 z-10 flex items-center justify-between bg-white px-12 py-8">
        <div className="flex items-center gap-6">
          <div className="flex h-12 w-12 items-center justify-center bg-zinc-50">
            <UserIcon className="h-5 w-5 text-zinc-400" />
          </div>
          <div>
            <p className="text-[10px] tracking-widest uppercase text-zinc-400 mb-1">User Profile</p>
            <p className="text-xs font-bold uppercase tracking-wider">{profile?.displayName}</p>
          </div>
        </div>
        <Button variant="ghost" onClick={logout} className="h-12 w-12 p-0">
          <LogOut className="h-4 w-4 text-zinc-400" />
        </Button>
      </header>

      <main className="mx-auto max-w-lg p-6 pb-32">
        <AnimatePresence mode="wait">
          {view === 'dashboard' ? (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              {/* --- Status Card --- */}
              <div className="py-12 text-center">
                <p className="mb-4 text-[10px] uppercase tracking-[0.4em] font-bold text-zinc-400">
                  {format(serverTime, 'EEEE, MMMM do')}
                </p>
                <h2 className="text-7xl font-light tracking-tighter text-zinc-900 mb-8">
                  {format(serverTime, 'HH:mm')}
                </h2>
                <div className="flex items-center justify-center gap-4">
                  <span className="text-[10px] uppercase tracking-widest font-bold text-zinc-400">
                    Status
                  </span>
                  <div className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    isCheckedIn ? "bg-forest" : "bg-zinc-200"
                  )} />
                  <span className="text-[10px] uppercase tracking-widest font-bold text-zinc-900">
                    {isCheckedIn ? "Checked in" : "Off the clock"}
                  </span>
                </div>
              </div>

              {/* --- Action Area --- */}
              <div className="space-y-12">
                {capturedPhoto ? (
                  <div className="relative grayscale hover:grayscale-0 transition-all duration-500">
                    <img src={capturedPhoto} alt="Selfie" className="w-full object-cover aspect-[4/5]" />
                    <button 
                      className="absolute bottom-8 right-8 text-[10px] uppercase tracking-widest font-bold text-white bg-black/20 backdrop-blur-sm px-4 py-2"
                      onClick={() => setCapturedPhoto(null)}
                    >
                      Recapture
                    </button>
                  </div>
                ) : showCamera ? (
                  <div className="relative bg-zinc-50 aspect-[4/5]">
                    <video ref={videoRef} autoPlay playsInline className="h-full w-full object-cover grayscale" />
                    <Button 
                      onClick={capturePhoto}
                      className="absolute bottom-12 left-1/2 -translate-x-1/2"
                    >
                      Capture
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center aspect-[4/5] bg-zinc-50">
                    <Camera className="mb-6 h-8 w-8 text-zinc-200 stroke-[1px]" />
                    <p className="text-[10px] uppercase tracking-widest text-zinc-400">Visual ID Required</p>
                  </div>
                )}

                {/* --- Action Button --- */}
                <div className="px-6">
                  {error && (
                    <div className="mb-8 text-center text-[10px] uppercase tracking-widest text-red-500 font-bold">
                      {error}
                    </div>
                  )}

                  {!isWithinRange && location && (
                    <div className="mb-8 text-center text-[10px] uppercase tracking-widest text-zinc-400">
                      Out of range ({Math.round(distance || 0)}m)
                    </div>
                  )}

                  {!capturedPhoto ? (
                    <Button 
                      onClick={startCamera} 
                      className="w-full"
                      disabled={showCamera || !isWithinRange}
                    >
                      Verify Identity
                    </Button>
                  ) : (
                    <Button 
                      onClick={handleAttendance} 
                      className="w-full"
                      disabled={isChecking || !isWithinRange}
                    >
                      {isChecking ? "Processing..." : (isCheckedIn ? "Check-out" : "Check-in")}
                    </Button>
                  )}
                </div>
              </div>

              {/* --- Info Area --- */}
              <div className="grid grid-cols-2">
                <div className="p-12 text-center border-r border-zinc-50">
                  <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-400 mb-2">Location</p>
                  <p className="text-xs uppercase tracking-widest font-bold text-zinc-900">
                    {isWithinRange ? "HQ - Verified" : "Out of bounds"}
                  </p>
                </div>
                <div className="p-12 text-center">
                  <p className="text-[10px] uppercase tracking-widest font-bold text-zinc-400 mb-2">Session</p>
                  <p className="text-xs uppercase tracking-widest font-bold text-zinc-900">
                    {isCheckedIn ? "Active" : "Null"}
                  </p>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="px-6 space-y-12"
            >
              <h2 className="text-[10px] uppercase tracking-[0.4em] font-bold text-zinc-400 text-center mb-16">Timeline</h2>
              <div className="space-y-1">
                {records.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-zinc-300">
                    <p className="text-[10px] uppercase tracking-widest">No activity recorded</p>
                  </div>
                ) : (
                  records.map((record) => (
                    <div key={record.id}>
                      <div className="flex items-center justify-between p-8 bg-zinc-50/50 hover:bg-zinc-50 transition-colors">
                        <div className="flex items-center gap-8">
                          <div className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            record.type === 'check-in' ? "bg-forest" : "bg-zinc-300"
                          )} />
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-900 mb-1">
                              {record.type.replace('-', ' ')}
                            </p>
                            <p className="text-[10px] text-zinc-400 uppercase tracking-widest">
                              {format(record.timestamp.toDate(), 'HH:mm — MMM d')}
                            </p>
                          </div>
                        </div>
                        <div className="h-12 w-12 grayscale hover:grayscale-0 transition-all duration-300">
                          <img src={record.photoUrl} alt="Visual ID" className="h-full w-full object-cover" />
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* --- Bottom Nav --- */}
      <nav className="fixed bottom-0 left-0 right-0 flex justify-center p-12 pointer-events-none">
        <div className="flex items-center gap-1 bg-white border border-zinc-100 p-1 pointer-events-auto">
          <button
            onClick={() => setView('dashboard')}
            className={cn(
              "px-8 py-3 text-[10px] font-bold uppercase tracking-widest transition-all",
              view === 'dashboard' ? "bg-forest text-white" : "text-zinc-400 hover:text-zinc-900"
            )}
          >
            Studio
          </button>
          <button
            onClick={() => setView('history')}
            className={cn(
              "px-8 py-3 text-[10px] font-bold uppercase tracking-widest transition-all",
              view === 'history' ? "bg-forest text-white" : "text-zinc-400 hover:text-zinc-900"
            )}
          >
            Archive
          </button>
        </div>
      </nav>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
