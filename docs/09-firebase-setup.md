# คู่มือติดตั้ง CWK Learning Hub รุ่น Firebase (ทีละขั้นตอน)

คู่มือนี้พาติดตั้งตั้งแต่ยังไม่มีอะไรเลย จนครูและนักเรียนเข้าใช้ได้ทั้งบนเว็บ (PWA), Android และ iOS
ใช้เวลาประมาณ 1–2 ชั่วโมงสำหรับส่วนเว็บ (ไม่รวมการส่งแอปขึ้นร้าน)

> ขั้นตอนบน Firebase Console อ้างอิงหน้าจอ ณ ปลายปี 2026 ชื่อเมนูอาจเปลี่ยนเล็กน้อยตามการอัปเดตของ Google

## สารบัญ

- [ส่วน A: สิ่งที่ต้องเตรียม](#ส่วน-a-สิ่งที่ต้องเตรียม)
- [ส่วน B: สร้างและตั้งค่าโปรเจกต์ใน Firebase Console](#ส่วน-b-สร้างและตั้งค่าโปรเจกต์ใน-firebase-console)
- [ส่วน C: เตรียมโค้ดบนเครื่อง](#ส่วน-c-เตรียมโค้ดบนเครื่อง)
- [ส่วน D: Deploy ขึ้น Firebase](#ส่วน-d-deploy-ขึ้น-firebase)
- [ส่วน E: สร้างโรงเรียนและผู้ดูแลคนแรก](#ส่วน-e-สร้างโรงเรียนและผู้ดูแลคนแรก)
- [ส่วน F: เข้าใช้ครั้งแรกและตั้งค่าข้อมูลโรงเรียน](#ส่วน-f-เข้าใช้ครั้งแรกและตั้งค่าข้อมูลโรงเรียน)
- [ส่วน G: ให้ครูและนักเรียนติดตั้งบนมือถือ (PWA)](#ส่วน-g-ให้ครูและนักเรียนติดตั้งบนมือถือ-pwa)
- [ส่วน H: สร้างแอป Android](#ส่วน-h-สร้างแอป-android)
- [ส่วน I: สร้างแอป iOS](#ส่วน-i-สร้างแอป-ios)
- [ส่วน J: ความปลอดภัยและค่าใช้จ่ายที่ควรตั้งเพิ่ม](#ส่วน-j-ความปลอดภัยและค่าใช้จ่ายที่ควรตั้งเพิ่ม)
- [ส่วน K: อัปเดตระบบภายหลัง](#ส่วน-k-อัปเดตระบบภายหลัง)
- [ส่วน L: แก้ปัญหาที่พบบ่อย](#ส่วน-l-แก้ปัญหาที่พบบ่อย)

---

## ส่วน A: สิ่งที่ต้องเตรียม

### A1. บัญชีและค่าใช้จ่าย

| รายการ | จำเป็นเมื่อ | หมายเหตุ |
| --- | --- | --- |
| บัญชี Google | ทุกกรณี | แนะนำบัญชีกลางของโรงเรียน (ไม่ใช่บัญชีส่วนตัวของครูคนใดคนหนึ่ง) เพื่อส่งต่องานได้ |
| บัตรเครดิต/เดบิต | ทุกกรณี | Firebase แพ็กเกจ **Blaze** (จ่ายตามใช้) จำเป็นสำหรับ Cloud Functions และ Cloud Storage — โรงเรียนขนาดกลางส่วนใหญ่ใช้อยู่ในโควตาฟรีรายเดือน แต่ต้องผูกบัตร |
| Google Play Developer | ถ้าจะลงแอปใน Google Play | ค่าสมัครครั้งเดียว |
| Apple Developer Program | ถ้าจะลงแอปใน App Store/TestFlight | ค่าสมาชิกรายปี และต้องมีเครื่อง Mac |

> ถ้าใช้บัญชี Google Workspace for Education ของโรงเรียน ผู้ดูแลโดเมนอาจตั้งนโยบายที่ทำให้ deploy ไม่ผ่าน (ดู [ส่วน L](#ส่วน-l-แก้ปัญหาที่พบบ่อย)) ถ้าไม่แน่ใจ ใช้บัญชี Gmail กลางของโรงเรียนจะง่ายที่สุด

### A2. โปรแกรมบนคอมพิวเตอร์ที่ใช้ติดตั้ง (Windows, macOS หรือ Linux)

1. **Node.js 22 (LTS)** — ดาวน์โหลดที่ <https://nodejs.org> ติดตั้งแล้วเปิด Terminal (Windows: PowerShell) พิมพ์

   ```bash
   node -v     # ต้องขึ้น v22.x.x ขึ้นไป
   npm -v
   ```

2. **Git** — <https://git-scm.com> (หรือดาวน์โหลดโค้ดเป็น ZIP จาก GitHub แทนได้)
3. (ไม่บังคับ) **Java 21** — ใช้เฉพาะเมื่อต้องการรันระบบสาธิตบนเครื่อง (`npm run dev:demo`) ไม่ต้องใช้สำหรับการติดตั้งจริง
4. (ไม่บังคับ) **Google Cloud CLI (gcloud)** — ใช้ใน [ส่วน E ทางเลือกที่ 2](#e2-ทางเลือกที่-2-ใช้-gcloud-เมื่อสร้างคีย์ไม่ได้) ถ้าสร้างไฟล์คีย์ service account ไม่ได้

สำหรับสร้างแอปเนทีฟ (ทำภายหลังได้):
- Android: **Android Studio** รุ่นล่าสุด (มี JDK และ Android SDK มาให้)
- iOS: **Mac + Xcode** รุ่นล่าสุดจาก App Store

---

## ส่วน B: สร้างและตั้งค่าโปรเจกต์ใน Firebase Console

ทำตามลำดับนี้ เพราะการ deploy ต้องมีบริการเหล่านี้ก่อน

### B1. สร้างโปรเจกต์

1. เข้า <https://console.firebase.google.com> ด้วยบัญชีจากข้อ A1
2. กด **สร้างโปรเจกต์ (Create a project)**
3. ตั้งชื่อ เช่น `cwk-learning-hub` — ระบบจะสร้าง **Project ID** ให้ (เช่น `cwk-learning-hub-1a2b3`) **จดไว้** ใช้หลายขั้นตอนต่อจากนี้ และจะเป็นส่วนหนึ่งของ URL `https://<project-id>.web.app`
4. หน้า Google Analytics: **ปิดได้** (ระบบไม่ได้ใช้) หน้า Gemini in Firebase: เลือกตามสะดวก
5. กด **สร้างโปรเจกต์** รอจนเสร็จ แล้วกด **ดำเนินการต่อ**

### B2. เปลี่ยนเป็นแพ็กเกจ Blaze

1. มุมซ้ายล่างของ Console จะเห็น **Spark (ไม่มีค่าใช้จ่าย)** → กด **อัปเกรด (Upgrade)**
2. เลือก **Blaze** → เลือกหรือสร้าง **Cloud Billing account** → กรอกข้อมูลบัตร
3. ระบบจะเสนอให้ตั้ง **งบประมาณแจ้งเตือน (budget alert)** — แนะนำตั้ง เช่น 300 บาท/เดือน (เป็นการแจ้งเตือนทางอีเมล ไม่ใช่การตัดบริการ)

### B3. เปิด Authentication (การเข้าสู่ระบบ)

1. เมนูซ้าย **Build → Authentication** → **Get started**
2. แท็บ **Sign-in method** → เลือก **Email/Password** → เปิด **Enable** (สวิตช์แรก) → **ไม่ต้อง**เปิด Email link → **Save**

   > นักเรียนไม่ต้องมีอีเมล ระบบแปลงรหัสนักเรียนเป็นอีเมลภายในให้เอง (ไม่มีการส่งอีเมลจริง)
3. (แนะนำ) แท็บ **Settings → User actions** → **ยกเลิกเครื่องหมาย** "Enable create (sign-up)" และ "Enable delete" แล้ว Save
   ระบบสร้างบัญชีผ่านเซิร์ฟเวอร์เท่านั้น (ผู้ดูแลเพิ่ม/นำเข้า หรือคำขอสมัครที่ต้องอนุมัติ) การปิดสองข้อนี้กันคนนอกสร้างบัญชีเองด้วย API key

### B4. สร้างฐานข้อมูล Firestore

1. เมนูซ้าย **Build → Firestore Database** → **Create database**
2. ถ้ามีให้เลือก edition → เลือก **Standard edition**
3. **Database ID**: ใช้ค่าเริ่มต้น `(default)` (**ห้ามเปลี่ยน** ระบบใช้ฐานข้อมูล default)
4. **Location**: เลือก **asia-southeast1 (Singapore)** — ใกล้ไทยที่สุด และ Cloud Functions ของระบบอยู่ภูมิภาคนี้ (**เปลี่ยนภายหลังไม่ได้**)
5. เลือก **Start in production mode** → **Create** (กฎความปลอดภัยจริงจะถูกอัปโหลดตอน deploy)

### B5. เปิด Cloud Storage (ที่เก็บไฟล์งาน)

1. เมนูซ้าย **Build → Storage** → **Get started**
2. Location: เลือก **asia-southeast1** (หรือภูมิภาคเดียวกับ Firestore)
3. เลือก **Start in production mode** → **Done**
4. หน้าแรกของ Storage จะแสดงชื่อ bucket เช่น `gs://cwk-learning-hub-1a2b3.firebasestorage.app` — ส่วนหลัง `gs://` คือค่า `storageBucket`

> ต้องเปิด Storage **ก่อน** deploy ครั้งแรก ไม่อย่างนั้นการ deploy กฎ Storage และฟังก์ชันอัปโหลดไฟล์จะผิดพลาด

### B6. ลงทะเบียน Web app เพื่อเอาค่า config

1. กลับไปหน้า **Project Overview** (ไอคอนบ้าน) → กดไอคอน **`</>`** (Add app → Web)
2. App nickname: เช่น `CWK Web` → **ไม่ต้อง**ติ๊ก "Also set up Firebase Hosting" (ไฟล์ตั้งค่ามีอยู่แล้ว) → **Register app**
3. จะเห็นโค้ดประมาณนี้ — **คัดลอกค่าเก็บไว้** ใช้ใน [ส่วน C3](#c3-ใส่ค่า-config-ของโปรเจกต์)

   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "cwk-learning-hub-1a2b3.firebaseapp.com",
     projectId: "cwk-learning-hub-1a2b3",
     storageBucket: "cwk-learning-hub-1a2b3.firebasestorage.app",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abcdef..."
   };
   ```

   ดูย้อนหลังได้ที่ ⚙️ **Project settings → General → Your apps**
4. **ไม่ต้อง**เพิ่มแอป Android/iOS ใน Firebase Console และไม่ต้องใช้ไฟล์ `google-services.json` หรือ `GoogleService-Info.plist` — แอปเนทีฟของระบบนี้ใช้ค่า config ชุดเว็บเดียวกัน

> ค่า config เหล่านี้**ไม่ใช่ความลับ** (อยู่ในแอปที่ทุกคนดาวน์โหลดได้อยู่แล้ว) ความปลอดภัยอยู่ที่ Security Rules และการตรวจสิทธิ์ใน Cloud Functions

---

## ส่วน C: เตรียมโค้ดบนเครื่อง

### C1. ดาวน์โหลดโค้ด

```bash
git clone https://github.com/cnbkruchin/CWK-learning-hub.git
cd CWK-learning-hub
git checkout claude/student-group-grading-system-k7mkc6    # ข้ามบรรทัดนี้หลังรวมเข้า branch หลักแล้ว
cd firebase
```

### C2. ติดตั้งแพ็กเกจ

ต้องติดตั้งสองที่: ตัวแอป/เครื่องมือ (`firebase/`) และ Cloud Functions (`firebase/functions/`)

```bash
npm install
cd functions
npm install
cd ..
```

ใช้เวลาหลายนาทีในครั้งแรก ถ้าขึ้นคำเตือน `npm warn ...` หรือ `vulnerabilities` ไม่เป็นไร ขอเพียงไม่ขึ้น `npm error`

### C3. ใส่ค่า config ของโปรเจกต์

1. คัดลอกไฟล์ตัวอย่าง

   ```bash
   # macOS / Linux
   cp app/.env.example app/.env.local
   ```

   ```powershell
   # Windows PowerShell
   Copy-Item app\.env.example app\.env.local
   ```

2. เปิด `app/.env.local` ด้วยโปรแกรมแก้ข้อความ (VS Code, Notepad) แล้วใส่ค่าจาก [B6](#b6-ลงทะเบียน-web-app-เพื่อเอาค่า-config) โดยไม่ต้องมีเครื่องหมายคำพูด

   ```ini
   VITE_FIREBASE_API_KEY=AIza...
   VITE_FIREBASE_AUTH_DOMAIN=cwk-learning-hub-1a2b3.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=cwk-learning-hub-1a2b3
   VITE_FIREBASE_STORAGE_BUCKET=cwk-learning-hub-1a2b3.firebasestorage.app
   VITE_FIREBASE_MESSAGING_SENDER_ID=1234567890
   VITE_FIREBASE_APP_ID=1:1234567890:web:abcdef...
   VITE_SCHOOL_CODE=CWK
   ```

   | ค่าในไฟล์ | มาจาก firebaseConfig |
   | --- | --- |
   | `VITE_FIREBASE_API_KEY` | `apiKey` |
   | `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
   | `VITE_FIREBASE_PROJECT_ID` | `projectId` |
   | `VITE_FIREBASE_STORAGE_BUCKET` | `storageBucket` |
   | `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
   | `VITE_FIREBASE_APP_ID` | `appId` |
   | `VITE_SCHOOL_CODE` | **รหัสโรงเรียน** ที่จะใช้ใน [ส่วน E](#ส่วน-e-สร้างโรงเรียนและผู้ดูแลคนแรก) (ตัวอักษรอังกฤษ/ตัวเลข เช่น `CWK`) — แสดงเป็นค่าเริ่มต้นในหน้าเข้าสู่ระบบ |

   ไฟล์ `.env.local` ถูกตั้งไม่ให้ขึ้น Git อยู่แล้ว

### C4. ผูกเครื่องกับโปรเจกต์ Firebase

```bash
npx firebase login
```

เบราว์เซอร์จะเปิดให้เลือกบัญชี Google (บัญชีเดียวกับที่สร้างโปรเจกต์) → อนุญาต → กลับมาที่ Terminal จะขึ้น `Success! Logged in as ...`

```bash
npx firebase use --add
```

- เลือก Project ID ของโรงเรียนด้วยลูกศร → Enter
- ช่อง "What alias do you want to use" พิมพ์ `default` → Enter
- จะได้ไฟล์ `.firebaserc` (ไม่ขึ้น Git)

ตรวจว่าผูกถูกโปรเจกต์:

```bash
npx firebase projects:list     # โปรเจกต์ที่ใช้อยู่จะมี (current)
```

### C5. (แนะนำ) ทดลองระบบสาธิตบนเครื่องก่อน

ข้ามได้ ต้องมี Java 21 — ไม่แตะโปรเจกต์จริง ข้อมูลหายเมื่อปิด

```bash
npm run dev:demo
```

เปิด <http://127.0.0.1:5173> เข้าระบบ `demo_admin` / `Demo#Pass2569` (รหัสโรงเรียน `DEMO`) กด Ctrl+C เพื่อปิด

---

## ส่วน D: Deploy ขึ้น Firebase

### D1. Deploy ทุกส่วนครั้งแรก

```bash
npm run deploy
```

คำสั่งนี้ build แอป (`app/dist`) แล้วอัปโหลดทั้งหมด: กฎ Firestore, ดัชนี (indexes), กฎ Storage, Cloud Functions และเว็บ (Hosting)

ระหว่าง deploy ครั้งแรกอาจมีคำถาม:

| คำถาม | ตอบ |
| --- | --- |
| เปิดใช้ API ต่าง ๆ (Cloud Functions, Cloud Build, Artifact Registry, Cloud Run, Eventarc, Pub/Sub, Cloud Scheduler) | ระบบเปิดให้อัตโนมัติ รอสักครู่ |
| `How many days do you want to keep container images before they're deleted?` | กด Enter (ค่าเริ่มต้น 1 วัน) — ลบไฟล์ build เก่า ประหยัดค่าพื้นที่ |

เมื่อสำเร็จจะเห็น

```text
✔  Deploy complete!
Hosting URL: https://<project-id>.web.app
```

ใช้เวลา 3–10 นาทีในครั้งแรก ถ้าครั้งแรกผิดพลาดเรื่องสิทธิ์ (permission/service agent) ให้รอ 5–10 นาทีแล้วรันซ้ำ — ดู [ส่วน L](#ส่วน-l-แก้ปัญหาที่พบบ่อย)

### D2. รอดัชนีฐานข้อมูลสร้างเสร็จ

1. Firebase Console → **Firestore Database → Indexes**
2. รอจนทุกรายการในแท็บ **Composite** และ **Single field** (exemptions ของ `enrollments`) มีสถานะ **Enabled** (มักไม่เกิน 10 นาที)

ระหว่างที่ยังสร้างไม่เสร็จ บางหน้า (รายวิชาของครู รายชื่อนักเรียน) อาจโหลดไม่ขึ้นหรือขึ้นข้อความไม่มีสิทธิ์ — เป็นเรื่องปกติ

### D3. ตรวจผลการ deploy

- **Functions**: Console → Build → Functions → ต้องมี `api` และ `cleanupUploads` ภูมิภาค `asia-southeast1`
- **Hosting**: เปิด `https://<project-id>.web.app` → ต้องเห็นหน้า "เข้าสู่ระบบ"
  (ถ้าเห็น "ยังไม่ได้ตั้งค่า Firebase" แปลว่า `app/.env.local` ไม่ถูกอ่าน — ดูส่วน L)

---

## ส่วน E: สร้างโรงเรียนและผู้ดูแลคนแรก

ทำครั้งเดียว ใช้สคริปต์ `scripts/bootstrap.mjs` สร้างข้อมูลโรงเรียนและบัญชีผู้ดูแลคนแรก (ผู้ดูแลระบบ + ผู้ดูแลคะแนน) พร้อมรหัสผ่านชั่วคราว
ต้องมีสิทธิ์ผู้ดูแลระดับ Google Cloud เลือกทางใดทางหนึ่ง

### E1. ทางเลือกที่ 1: ใช้ไฟล์คีย์ service account

1. Firebase Console → ⚙️ **Project settings → Service accounts** → **Generate new private key** → **Generate key**
2. ย้ายไฟล์ที่ดาวน์โหลดมาไว้ในโฟลเดอร์ `firebase/` และเปลี่ยนชื่อเป็น `service-account.json` (ชื่อนี้ถูกตั้งไม่ให้ขึ้น Git)
3. รันคำสั่ง (เปลี่ยน `<project-id>`, รหัสโรงเรียน, ชื่อโรงเรียน, ชื่อผู้ใช้ผู้ดูแลตามต้องการ — รหัสโรงเรียนต้องตรงกับ `VITE_SCHOOL_CODE`)

   ```bash
   # macOS / Linux
   GOOGLE_APPLICATION_CREDENTIALS=service-account.json GCLOUD_PROJECT=<project-id> \
     node scripts/bootstrap.mjs --code CWK --name "โรงเรียนจุนวิทยาคม" --admin admin
   ```

   ```powershell
   # Windows PowerShell
   $env:GOOGLE_APPLICATION_CREDENTIALS="service-account.json"
   $env:GCLOUD_PROJECT="<project-id>"
   node scripts/bootstrap.mjs --code CWK --name "โรงเรียนจุนวิทยาคม" --admin admin
   ```

4. **ลบไฟล์คีย์ทิ้งทันทีหลังใช้** และลบคีย์ใน Google Cloud: Project settings → Service accounts → **Manage service account permissions** (ไปยัง Google Cloud Console) → เลือกบัญชี `firebase-adminsdk-...` → แท็บ **Keys** → ลบคีย์ที่เพิ่งสร้าง
   ไฟล์คีย์นี้มีสิทธิ์เต็มต่อข้อมูลทั้งหมด ห้ามส่งต่อหรือ commit

### E2. ทางเลือกที่ 2: ใช้ gcloud (เมื่อสร้างคีย์ไม่ได้)

องค์กรที่ใช้ Google Workspace มักปิดการสร้างคีย์ service account ไว้ ใช้บัญชีของคุณเองแทน (ต้องเป็น Owner/Editor ของโปรเจกต์)

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project <project-id>
GCLOUD_PROJECT=<project-id> node scripts/bootstrap.mjs --code CWK --name "โรงเรียนจุนวิทยาคม" --admin admin
```

(Windows PowerShell: ตั้ง `$env:GCLOUD_PROJECT="<project-id>"` แล้วรัน `node scripts/bootstrap.mjs ...`)

### E3. ผลลัพธ์

```text
สร้างโรงเรียนแล้ว schoolId=xxxxxxxx
บัญชีผู้ดูแล: admin  รหัสผ่านชั่วคราว: Ab3dEf...  (ต้องเปลี่ยนเมื่อเข้าใช้ครั้งแรก — ห้ามบันทึกรหัสนี้ไว้ที่อื่น)
```

จดรหัสผ่านชั่วคราวไว้ใช้ในขั้นถัดไป (แสดงครั้งเดียว) ถ้ารันซ้ำด้วยรหัสโรงเรียนเดิมจะขึ้น "มีโรงเรียนรหัส ... แล้ว" — ไม่สร้างซ้ำ

---

## ส่วน F: เข้าใช้ครั้งแรกและตั้งค่าข้อมูลโรงเรียน

1. เปิด `https://<project-id>.web.app`
2. ชื่อผู้ใช้ `admin` · รหัสผ่านชั่วคราวจาก E3 · กด "รหัสโรงเรียน" ตรวจว่าเป็น `CWK` (ตามที่ใช้ใน bootstrap) → **เข้าสู่ระบบ**
3. ระบบบังคับ **ตั้งรหัสผ่านใหม่** (อย่างน้อย 8 ตัวอักษร ไม่มีชื่อผู้ใช้อยู่ในรหัส)
4. ตั้งค่าตามลำดับในหน้า **ผู้ดูแลระบบ**

   | ลำดับ | เมนู | ทำอะไร |
   | --- | --- | --- |
   | 1 | ⚙️ ตั้งค่าระบบ | ชื่อระบบ, ขนาด/จำนวน/ชนิดไฟล์ที่รับ, เปิด-ปิดการสมัครเองของนักเรียน และรหัสลงทะเบียน |
   | 2 | 📚 ปีการศึกษาและรายวิชา | เพิ่มปีการศึกษา (สร้างภาค 1 และ 2 ให้) และรายวิชาในหลักสูตร |
   | 3 | 🧑‍🏫 ครูและบทบาท | เพิ่มครู → ระบบแสดงชื่อผู้ใช้ + รหัสผ่านชั่วคราว (ครั้งเดียว) ส่งให้ครู · ให้บทบาทผู้ดูแลคะแนน/ผู้ดูแลระบบเพิ่มได้ |
   | 4 | 📥 นำเข้านักเรียน | คัดลอกตารางจาก Excel (หัวตาราง: รหัสนักเรียน, คำนำหน้า, ชื่อ, นามสกุล, ชั้น, ห้อง, เลขที่) → ตรวจข้อมูล → ยืนยัน → **ดาวน์โหลด CSV บัญชี** เก็บไว้แจกนักเรียน |
   | 5 | ครูแต่ละคน | เข้าระบบ → เปิดรายวิชา → เพิ่มนักเรียน (หรือเปิดรหัสเข้าร่วมให้นักเรียนลงทะเบียนเอง) → จัดกลุ่ม → เพิ่มงาน |

5. ทดสอบเรียลไทม์: เปิดสองเครื่อง (ครู + นักเรียน) ให้คะแนนแล้วกด "ประกาศคะแนนงานนี้" หน้าคะแนนของนักเรียนต้องเปลี่ยนทันที

แจ้งครู/นักเรียน: **URL ของระบบ**, **รหัสโรงเรียน**, ชื่อผู้ใช้ (นักเรียน = รหัสนักเรียน) และรหัสผ่านชั่วคราว ลืมรหัสผ่านให้ผู้ดูแลกด "รีเซ็ตรหัสผ่าน"

### F1. (ไม่บังคับ) ใช้โดเมนของโรงเรียน

Console → **Build → Hosting → Add custom domain** → ใส่ เช่น `learn.cwk.ac.th` → เพิ่มระเบียน DNS ตามที่ Firebase แสดงที่ผู้ให้บริการโดเมน → รอใบรับรอง SSL (สูงสุด 24 ชั่วโมง)

---

## ส่วน G: ให้ครูและนักเรียนติดตั้งบนมือถือ (PWA)

ไม่ต้องผ่านร้านแอป ใช้ได้ทันทีหลังส่วน F และอัปเดตเองทุกครั้งที่ deploy

| เครื่อง | วิธีติดตั้ง |
| --- | --- |
| iPhone / iPad | เปิด URL ด้วย **Safari** → ปุ่ม **แชร์** (สี่เหลี่ยมมีลูกศรขึ้น) → **เพิ่มไปยังหน้าจอโฮม** → เพิ่ม |
| Android | เปิดด้วย **Chrome** → แถบ "ติดตั้งแอปไว้บนหน้าจอหลัก" ด้านบนของแอป → **ติดตั้ง** (หรือเมนู ⋮ → **ติดตั้งแอป / เพิ่มลงในหน้าจอหลัก**) |
| Huawei / HarmonyOS / แท็บเล็ตอื่น | เปิดด้วยเบราว์เซอร์ของเครื่อง → เมนู → เพิ่มลงหน้าจอหลัก |
| คอมพิวเตอร์ | Chrome/Edge → ไอคอนติดตั้งในช่อง URL |

---

## ส่วน H: สร้างแอป Android

ต้องทำ [ส่วน C3](#c3-ใส่ค่า-config-ของโปรเจกต์) ก่อน เพราะค่า config ถูกใส่ในแอปตอน build รองรับ Android 7.0 (API 24) ขึ้นไป

### H1. ตั้งรหัสแอป (ทำครั้งเดียวก่อนส่งขึ้นร้าน — เปลี่ยนภายหลังไม่ได้)

รหัสแอปตอนนี้คือ `th.cwk.learninghub` ถ้าต้องการเปลี่ยน (เช่น `th.ac.cwk.learninghub`) แก้ 3 ที่ให้ตรงกัน:
- `capacitor.config.json` → `"appId"`
- `android/app/build.gradle` → `namespace` และ `applicationId`
- `android/app/src/main/res/values/strings.xml` → `package_name` และ `custom_url_scheme`

และย้ายโฟลเดอร์ `android/app/src/main/java/th/cwk/learninghub/` ให้ตรงชื่อใหม่ พร้อมแก้บรรทัด `package` ใน `MainActivity.java`
(ถ้ายังไม่แน่ใจ ใช้รหัสเดิมได้)

### H2. Build และเปิด Android Studio

```bash
npm run cap:android
```

คำสั่งนี้ build เว็บ → คัดลอกเข้า `android/` → เปิด Android Studio

1. ครั้งแรก Android Studio จะดาวน์โหลด Gradle และ SDK ที่ต้องใช้ — รอจน **Gradle sync** เสร็จ (แถบล่างไม่หมุนแล้ว)
2. ทดลองบนมือถือจริง: เปิด **Developer options → USB debugging** บนมือถือ เสียบสาย USB → เลือกเครื่องในแถบด้านบน → กด ▶ **Run**

### H3. ตั้งเลขรุ่น

`android/app/build.gradle` → `versionCode` (เพิ่มทีละ 1 ทุกครั้งที่ส่งร้าน) และ `versionName` (เช่น `1.0.0`)

### H4. สร้างไฟล์สำหรับแจก/ส่งร้าน

1. Android Studio → **Build → Generate Signed App Bundle or APK**
2. เลือก **Android App Bundle** (ส่ง Google Play) หรือ **APK** (แจกติดตั้งเองในโรงเรียน)
3. **Key store path → Create new** → สร้างไฟล์ keystore ตั้งรหัสผ่าน
   > **เก็บไฟล์ keystore และรหัสผ่านไว้อย่างปลอดภัย (สำรองหลายที่)** — หากหาย จะอัปเดตแอปเดิมใน Google Play ไม่ได้
4. เลือก **release** → **Create** ได้ไฟล์ที่ `android/app/release/`

### H5. ส่งขึ้น Google Play

<https://play.google.com/console> → Create app → ตั้งค่ารายละเอียดร้าน (ไอคอนอยู่ที่ `resources/icon.png`) นโยบายความเป็นส่วนตัว แบบฟอร์ม Data safety (ระบบเก็บชื่อ รหัสนักเรียน ไฟล์งาน คะแนน) → อัปโหลด `.aab` ใน Testing (Internal) ก่อน แล้วค่อย Production

---

## ส่วน I: สร้างแอป iOS

ต้องใช้ Mac + Xcode และทำ [ส่วน C](#ส่วน-c-เตรียมโค้ดบนเครื่อง) บน Mac รองรับ iOS 15 ขึ้นไป

1. (ถ้าเปลี่ยนรหัสแอปใน H1) แก้ `capacitor.config.json` แล้วรัน `npx cap sync`
2. เปิดโปรเจกต์

   ```bash
   npm run cap:ios
   ```

3. ใน Xcode เลือกโปรเจกต์ **App** → target **App** → แท็บ **Signing & Capabilities**
   - ติ๊ก **Automatically manage signing** → **Team** เลือกบัญชี Apple Developer
   - **Bundle Identifier** ตรงกับ `appId` (ค่าเริ่มต้น `th.cwk.learninghub`)
4. แท็บ **General** → **Version** (เช่น 1.0.0) และ **Build** (เพิ่มทุกครั้งที่ส่ง)
5. ทดลอง: เสียบ iPhone → เลือกเครื่อง → ▶ Run (ครั้งแรกต้องเปิด Developer Mode บน iPhone: Settings → Privacy & Security → Developer Mode)
6. ส่ง TestFlight/App Store: เลือกปลายทาง **Any iOS Device** → **Product → Archive** → **Distribute App → App Store Connect → Upload**
7. <https://appstoreconnect.apple.com> → เลือกแอป → TestFlight (ให้ครูทดสอบ) → เมื่อพร้อม ส่งตรวจ (App Review)

ข้อความขอสิทธิ์กล้อง/รูปภาพภาษาไทยตั้งไว้แล้วใน `ios/App/App/Info.plist`

---

## ส่วน J: ความปลอดภัยและค่าใช้จ่ายที่ควรตั้งเพิ่ม

1. **งบประมาณแจ้งเตือน**: <https://console.cloud.google.com/billing> → Budgets & alerts (ถ้ายังไม่ได้ตั้งใน B2)
2. **สำรองข้อมูล Firestore**: Console → Firestore Database → **Backups** (หรือ Disaster recovery) → ตั้งสำรองรายวัน/รายสัปดาห์ และพิจารณาเปิด Point-in-time recovery
3. **App Check** (กันคนเรียกใช้ระบบจากนอกแอป): Console → Build → App Check — เว็บใช้ reCAPTCHA Enterprise, Android ใช้ Play Integrity, iOS ใช้ App Attest ต้องเพิ่มโค้ดฝั่งแอปก่อนบังคับใช้ (ยังไม่ได้ใส่ในรุ่นนี้)
4. **ข้อจำกัด API key**: ถ้าจะจำกัด API key ใน Google Cloud Console → APIs & Services → Credentials ห้ามจำกัดด้วย "Websites" อย่างเดียว เพราะแอป Android/iOS ส่งคำขอจาก `https://localhost` และ `capacitor://localhost` — ให้จำกัดด้วยรายการ API แทน
5. **ผู้ดูแลหลายคน**: ให้บทบาทผู้ดูแลระบบอย่างน้อย 2 คน (เมนู ครูและบทบาท) กันกรณีลืมรหัสผ่าน
6. เพิ่มคนดูแลโปรเจกต์ Firebase: Project settings → **Users and permissions** → Add member (สิทธิ์ Owner สำหรับผู้ดูแลระบบ IT ของโรงเรียน)

---

## ส่วน K: อัปเดตระบบภายหลัง

```bash
cd CWK-learning-hub
git pull
cd firebase
npm install
cd functions && npm install && cd ..
npm run deploy
```

- **เว็บ/PWA**: ผู้ใช้ได้รุ่นใหม่เมื่อเปิดแอปครั้งถัดไป
- **แอป Android/iOS**: ข้อมูลอยู่บน Firebase จึงไม่ต้องอัปเดตแอปเมื่อแก้แค่ข้อมูล แต่ถ้าแก้หน้าจอ ต้อง `npm run cap:sync` → เพิ่มเลขรุ่น (H3 / I4) → build และส่งร้านใหม่
- deploy เฉพาะบางส่วนได้ เช่น `npx firebase deploy --only hosting` หรือ `--only functions` หรือ `--only firestore:rules`

---

## ส่วน L: แก้ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
| --- | --- |
| deploy ขึ้น `requires the pay-as-you-go (Blaze) billing plan` | ยังไม่ได้อัปเกรด → ทำ [B2](#b2-เปลี่ยนเป็นแพ็กเกจ-blaze) |
| deploy ขึ้น `Firebase Storage has not been set up` | ยังไม่ได้เปิด Storage → ทำ [B5](#b5-เปิด-cloud-storage-ที่เก็บไฟล์งาน) แล้ว deploy ใหม่ |
| deploy ครั้งแรกล้มเหลวเรื่อง permission / service agent / Eventarc | Google ยังตั้งสิทธิ์ภายในไม่เสร็จ → รอ 5–10 นาที แล้วรัน `npx firebase deploy --only functions` |
| deploy ขึ้น `Failed to set the IAM Policy ... allUsers` หรือ `organization policy` | บัญชี Workspace ของโรงเรียนมีนโยบายห้ามเปิดบริการสาธารณะ (Domain restricted sharing) → ให้ผู้ดูแล Workspace ยกเว้นโปรเจกต์นี้ หรือสร้างโปรเจกต์ด้วยบัญชี Gmail ที่ไม่อยู่ในองค์กร |
| เปิดเว็บแล้วขึ้น "ยังไม่ได้ตั้งค่า Firebase" | ไม่มี `app/.env.local` หรือวางผิดโฟลเดอร์ (ต้องอยู่ใน `firebase/app/`) หรือชื่อตัวแปรผิด → แก้แล้ว `npm run deploy` ใหม่ |
| เข้าสู่ระบบไม่ได้ "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" ทั้งที่ถูก | รหัสโรงเรียนในหน้าเข้าสู่ระบบไม่ตรงกับ `--code` ที่ใช้ใน bootstrap / ยังไม่ได้เปิด Email/Password ([B3](#b3-เปิด-authentication-การเข้าสู่ระบบ)) |
| ขึ้น "บัญชีนี้ถูกปิดใช้งานหรือยังรอผู้ดูแลอนุมัติ" | ผู้ดูแลปิดบัญชี หรือเป็นคำขอสมัครที่ยังไม่อนุมัติ (เมนู คำขอสมัครใช้งาน) |
| หลัง deploy บางหน้าโหลดไม่ขึ้น / "คุณไม่มีสิทธิ์ดู" | ดัชนียังสร้างไม่เสร็จ → รอตาม [D2](#d2-รอดัชนีฐานข้อมูลสร้างเสร็จ) แล้วรีเฟรช |
| bootstrap ขึ้น `Could not load the default credentials` | ไม่ได้ตั้ง `GOOGLE_APPLICATION_CREDENTIALS` (E1) หรือยังไม่ได้ `gcloud auth application-default login` (E2) |
| bootstrap ขึ้นเรื่อง `quota project` | รัน `gcloud auth application-default set-quota-project <project-id>` |
| สร้างคีย์ service account ไม่ได้ (Key creation is disabled) | นโยบายองค์กร → ใช้ [E2](#e2-ทางเลือกที่-2-ใช้-gcloud-เมื่อสร้างคีย์ไม่ได้) |
| อัปโหลดไฟล์งานไม่ผ่าน "ชนิดไฟล์นี้ไม่อนุญาต" | ตรวจชนิดไฟล์ในตั้งค่าระบบและในงานนั้น ระบบตรวจจากเนื้อไฟล์จริง ไฟล์ที่เปลี่ยนนามสกุลจะไม่ผ่าน |
| แอป Android/iOS เข้าสู่ระบบไม่ได้แต่เว็บได้ | API key ถูกจำกัดด้วย Websites → ดู [J4](#ส่วน-j-ความปลอดภัยและค่าใช้จ่ายที่ควรตั้งเพิ่ม) / build แอปก่อนใส่ `.env.local` → ใส่แล้ว `npm run cap:sync` และ build ใหม่ |
| ค่าใช้จ่ายสูงผิดปกติ | ดู Console → Usage and billing ว่าเป็นบริการใด หน้า "นักเรียน" ของผู้ดูแลและสมุดคะแนนอ่านข้อมูลมากที่สุด |

ดูภาพรวมสถาปัตยกรรมและการทดสอบที่ [firebase/README.md](../firebase/README.md)
