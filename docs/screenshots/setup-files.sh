#!/bin/bash
SERVER_NAME=$1

if [ "$SERVER_NAME" = "production" ]; then
  # Production: Node.js app
  APP_DIR="/home/deploy/app"
  mkdir -p "$APP_DIR/src" "$APP_DIR/tests" "$APP_DIR/public" "$APP_DIR/config"

  cat > "$APP_DIR/src/app.ts" << 'APPEOF'
import express from 'express';
import { Router } from './routes';
import { loadConfig } from './config';
import { connectDB } from './db';

const app = express();
const config = loadConfig();

// TODO: Add rate limiting middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS setup
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', config.corsOrigin);
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.use('/api', Router);
app.use('/health', (req, res) => res.json({ status: 'ok' }));

// Static files
app.use(express.static('public'));

// FIXME: Handle connection timeout gracefully
connectDB(config.databaseUrl).then(() => {
  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
    console.log(`Environment: ${config.env}`);
  });
}).catch((err) => {
  console.error('Failed to connect to database:', err);
  process.exit(1);
});

export default app;
APPEOF

  cat > "$APP_DIR/src/routes.ts" << 'ROUTESEOF'
import { Router as ExpressRouter } from 'express';
import { authenticate } from './middleware/auth';
import { UserController } from './controllers/user';
import { ProductController } from './controllers/product';

export const Router = ExpressRouter();

// TODO: Add input validation
Router.get('/users', authenticate, UserController.list);
Router.get('/users/:id', authenticate, UserController.get);
Router.post('/users', authenticate, UserController.create);
Router.put('/users/:id', authenticate, UserController.update);
Router.delete('/users/:id', authenticate, UserController.delete);

Router.get('/products', ProductController.list);
Router.get('/products/:id', ProductController.get);
Router.post('/products', authenticate, ProductController.create);

// TODO: Cache database queries
Router.get('/stats', authenticate, async (req, res) => {
  const stats = await req.app.locals.db.getStats();
  res.json(stats);
});
ROUTESEOF

  cat > "$APP_DIR/src/config.ts" << 'CONFIGEOF'
export interface AppConfig {
  port: number;
  env: string;
  databaseUrl: string;
  corsOrigin: string;
  jwtSecret: string;
  logLevel: string;
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    env: process.env.NODE_ENV || 'production',
    databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/app',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}
CONFIGEOF

  cat > "$APP_DIR/src/db.ts" << 'DBEOF'
import { Pool, PoolClient } from 'pg';

let pool: Pool;

// FIXME: Connection pool limit should be configurable
export async function connectDB(url: string): Promise<void> {
  pool = new Pool({
    connectionString: url,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  const client = await pool.connect();
  try {
    await client.query('SELECT NOW()');
    console.log('Database connected successfully');
  } finally {
    client.release();
  }
}

// TODO: Add connection retry logic
export async function query(text: string, params?: any[]) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 100) {
    console.warn(`Slow query (${duration}ms):`, text);
  }
  return res;
}

export function getPool(): Pool {
  return pool;
}
DBEOF

  cat > "$APP_DIR/package.json" << 'PKGEOF'
{
  "name": "production-app",
  "version": "2.1.0",
  "description": "Production web application",
  "main": "dist/app.js",
  "scripts": {
    "start": "node dist/app.js",
    "dev": "ts-node-dev src/app.ts",
    "build": "tsc",
    "test": "jest",
    "lint": "eslint src/"
  },
  "dependencies": {
    "express": "^4.18.2",
    "pg": "^8.11.3",
    "jsonwebtoken": "^9.0.2",
    "bcrypt": "^5.1.1",
    "cors": "^2.8.5"
  },
  "devDependencies": {
    "typescript": "^5.3.3",
    "@types/express": "^4.17.21",
    "@types/node": "^20.10.6",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.1"
  }
}
PKGEOF

  cat > "$APP_DIR/tsconfig.json" << 'TSEOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
TSEOF

  cat > "$APP_DIR/Dockerfile" << 'DOCKEOF'
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY dist/ ./dist/

EXPOSE 3000

CMD ["node", "dist/app.js"]
DOCKEOF

  cat > "$APP_DIR/.env" << 'ENVEOF'
PORT=3000
NODE_ENV=production
DATABASE_URL=postgresql://app:secret@db:5432/production
JWT_SECRET=super-secret-jwt-key
CORS_ORIGIN=https://example.com
LOG_LEVEL=info
ENVEOF

  cat > "$APP_DIR/tests/app.test.ts" << 'TESTEOF'
import request from 'supertest';
import app from '../src/app';

describe('Health Check', () => {
  it('should return ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('API Routes', () => {
  it('should require authentication for users', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('should list products without auth', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
  });
});
TESTEOF

  echo "# Production App" > "$APP_DIR/README.md"
  echo "" >> "$APP_DIR/README.md"
  echo "Express.js production application." >> "$APP_DIR/README.md"

  # Create nginx config
  mkdir -p /home/deploy/nginx
  cat > /home/deploy/nginx/nginx.conf << 'NGINXEOF'
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /static {
        alias /var/www/html/public;
        expires 30d;
    }
}
NGINXEOF

  chown -R deploy:deploy /home/deploy

elif [ "$SERVER_NAME" = "staging" ]; then
  # Staging: Different app structure
  APP_DIR="/home/deploy/webapp"
  mkdir -p "$APP_DIR/src/components" "$APP_DIR/src/pages" "$APP_DIR/src/utils" "$APP_DIR/public"

  cat > "$APP_DIR/src/index.tsx" << 'INDEXEOF'
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/global.css';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

// FIXME: StrictMode causes double renders in dev
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
INDEXEOF

  cat > "$APP_DIR/src/App.tsx" << 'APPEOF'
import React, { Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Header } from './components/Header';
import { Footer } from './components/Footer';

// TODO: Add error boundary
const Home = React.lazy(() => import('./pages/Home'));
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const Settings = React.lazy(() => import('./pages/Settings'));

export default function App() {
  return (
    <div className="app">
      <Header />
      <main>
        <Suspense fallback={<div>Loading...</div>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
APPEOF

  cat > "$APP_DIR/src/components/Header.tsx" << 'HEADEREOF'
import React from 'react';
import { Link } from 'react-router-dom';

// HACK: Inline styles until CSS modules are set up
export function Header() {
  return (
    <header style={{ padding: '1rem', background: '#1a1a2e' }}>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/dashboard">Dashboard</Link>
        <Link to="/settings">Settings</Link>
      </nav>
    </header>
  );
}
HEADEREOF

  cat > "$APP_DIR/package.json" << 'PKGEOF'
{
  "name": "staging-webapp",
  "version": "0.8.0",
  "private": true,
  "scripts": {
    "start": "react-scripts start",
    "build": "react-scripts build",
    "test": "react-scripts test",
    "lint": "eslint src/"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.21.1",
    "axios": "^1.6.3"
  },
  "devDependencies": {
    "typescript": "^5.3.3",
    "@types/react": "^18.2.45",
    "eslint": "^8.56.0"
  }
}
PKGEOF

  cat > "$APP_DIR/tsconfig.json" << 'TSEOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "ES2020"],
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true
  },
  "include": ["src"]
}
TSEOF

  echo "# Staging Web App" > "$APP_DIR/README.md"
  echo "" >> "$APP_DIR/README.md"
  echo "React staging application." >> "$APP_DIR/README.md"

  chown -R deploy:deploy /home/deploy
fi
