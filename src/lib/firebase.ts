import { initializeApp } from 'firebase/app';
import { initializeFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

// Initialize Firestore utilizing long-polling to prevent WebSocket or gRPC blocking inside cloud containers and sandboxed iframes
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
}, firebaseConfig.firestoreDatabaseId);

// Test connection
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log("Firebase connection test succeeded: Online.");
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('the client is offline') || errorMsg.includes('Could not reach')) {
      console.warn("Firebase client is currently offline or unable to reach the backend:", errorMsg);
      console.error("Please check your Firebase configuration.");
    } else if (errorMsg.includes('permission-denied') || errorMsg.includes('permissions')) {
      console.log("Firebase connectivity verified (Permission expected for test doc): Online.");
    } else {
      console.error("Firebase connection test returned other error:", errorMsg);
    }
  }
}
testConnection();
