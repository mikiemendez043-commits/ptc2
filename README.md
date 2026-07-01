# PTC-Catanduanes Exam System (Server Edition)

This is the server-backed rewrite of the exam system. The previous version stored
everything in browser `localStorage`, which only lives on one browser on one device —
that's why questions and results disappeared after a restart or when opened in a
different browser/profile. This version stores everything in a real database on a
server, so all staff and students share the same data over the network.

## What changed from the old version

- **Data storage**: SQLite database file (`data/exam.db`) on the server, not browser
  storage. All staff and students hitting the same server see the same data.
- **Images**: stored as actual files in `data/images/`, not giant base64 strings.
- **Scoring**: computed on the server from the real answer key. The browser never
  sees the correct answers while a student is taking the exam, and never sends a
  score — it only sends which choice was picked for each question.
- **One-attempt-per-exam rule**: enforced by a database constraint, not just
  client-side JavaScript, so it can't be bypassed by editing the page.
- **Staff login**: still a single shared username/password (as you asked), but now
  checked server-side with a session cookie instead of a hardcoded check anyone
  could read in the browser's dev tools.

## Requirements

- [Node.js](https://nodejs.org) version 22.5 or later (includes `npm`). Download the
  "LTS" installer for your OS and click through it like any other program — there's
  nothing else to configure for installation itself. (This project uses Node's
  built-in SQLite support, which avoids needing Python/build tools that older
  database libraries require — but it does mean you need a fairly recent Node.)

## First-time setup

1. Copy this whole `exam-system` folder onto the machine that will act as the server.
2. Open a terminal/command prompt in that folder.
3. Run:
   ```
   npm install
   ```
   This downloads the three libraries the server needs (Express, better-sqlite3,
   express-session, multer) into a `node_modules` folder. You only need to do this
   once (and again if you ever delete `node_modules`).
4. Start the server:
   ```
   npm start
   ```
   You should see:
   ```
   PTC-Catanduanes Exam System running at http://localhost:3000
   ```
5. On the same machine, open a browser to `http://localhost:3000`. On other devices
   on the same network, use the server machine's local IP address instead of
   `localhost`, e.g. `http://192.168.1.50:3000` (see "Finding your server's network
   address" below).

Default staff login: username `admin`, password `admin123`. **Change these** (see
below) before letting other people use the system.

## Keeping it running

Closing the terminal window stops the server. For real use you want it to keep
running in the background and restart automatically if it crashes or the machine
reboots. The simplest tool for this is **pm2**:

```
npm install -g pm2
pm2 start server/index.js --name exam-system
pm2 save
pm2 startup
```

`pm2 startup` prints a command to run once so the server comes back automatically
after a reboot — follow the instructions it prints for your OS.

To check on it later: `pm2 status` and `pm2 logs exam-system`.

## Changing the staff password

By default the username is `admin` and password is `admin123` — same demo values as
before, just enforced server-side now. To change them, set environment variables
before starting the server. On Windows (Command Prompt):

```
set STAFF_USERNAME=yourusername
set STAFF_PASSWORD=yourpassword
npm start
```

On Mac/Linux:

```
STAFF_USERNAME=yourusername STAFF_PASSWORD=yourpassword npm start
```

If you're using pm2, put these in a `.env`-style setup or an ecosystem file —
ask if you want help wiring that up.

## Finding your server's network address

So students/other staff on the same WiFi/network can reach it:

- **Windows**: open Command Prompt, run `ipconfig`, look for "IPv4 Address" under
  your active network adapter (e.g. `192.168.1.50`).
- **Mac**: System Settings → Wi-Fi → Details, or run `ipconfig getifaddr en0` in
  Terminal.
- **Linux**: run `hostname -I` or `ip addr`.

Then everyone on the same network visits `http://THAT-ADDRESS:3000`. If it doesn't
load from other devices, check the server machine's firewall allows incoming
connections on port 3000.

For access beyond your local network (e.g. over the internet, from home), you'd need
either a cloud VPS or a tunneling tool — ask if you want help setting that up, since
it also raises security considerations (HTTPS, stronger auth) worth doing properly.

## Backing up your data

Everything important lives in two places:
- `data/exam.db` (and its `-wal`/`-shm` companion files while the server is running)
- `data/images/` (uploaded question images)

To back up: stop the server, copy the whole `data` folder somewhere safe, restart.
To restore: stop the server, replace the `data` folder with your backup, restart.

## Project structure

```
exam-system/
  package.json
  server/
    index.js       <- main server, all API routes
    db.js          <- database connection and schema
    constants.js   <- exam types, qualifications, rating logic
    auth.js         <- staff session check
  public/           <- everything served to browsers
    index.html
    staff-login.html
    staff-dashboard.html
    staff-exam-builder.html
    staff-results.html
    student-exam.html
    app.js          <- client-side API calls and shared UI helpers
    styles.css
  data/             <- created automatically; database + uploaded images live here
```

## Note on scale

SQLite with WAL mode (enabled by default in this setup) comfortably handles many
concurrent readers and a steady stream of writes — fine for "hundreds of students,
many staff" usage on a single server. If you ever outgrow a single machine, the
clean next step is moving to PostgreSQL, but that's unlikely to be necessary here.
