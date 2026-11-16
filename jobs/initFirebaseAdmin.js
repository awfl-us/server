// Firebase Admin remains needed for authentication and the legacy native
// durable executor while document persistence is migrated to Storage.
import { getApps, initializeApp } from 'firebase-admin/app';
if (!getApps().length) initializeApp();
