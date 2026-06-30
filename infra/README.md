# Chez Maurice Infrastructure

This directory contains infrastructure configurations for the Chez Maurice stack (launchd services, installer, Qdrant for the semantic corpus).

## Qdrant (Vector Database)

The corpus indexer expects a Qdrant endpoint on `localhost:6333`. The compose file now includes a `akita-qdrant` service with its data stored in a Docker volume (`qdrant_storage`). Start it the same way as MongoDB:

```bash
cd infra
docker compose up -d qdrant
```

The first run will create the persistent volume under Docker’s control. To inspect the UI/API:

```bash
open http://localhost:6333/dashboard
```

If you change Qdrant credentials/endpoints, update `tools/corpus/config/corpus.yaml` accordingly. To wipe Qdrant data locally:

```bash
docker compose stop qdrant
docker compose rm qdrant
docker volume rm infra_qdrant_storage
```

Restarting will create a fresh, empty collection (the corpus indexer recreates collections as needed).

## MongoDB Setup

### Understanding MongoDB Initialization

**IMPORTANT**: MongoDB initialization happens **ONLY on the first startup** when the database has no data. The environment variables you set will determine the admin credentials that MongoDB creates.

### Environment Variables Explained

The repo-wide `.env` file (at the root of this repository) contains these variables:

1. **`MONGO_ROOT_USERNAME`**: The admin username that will be created on first startup
   - Default: `admin`
   - This is the superuser account for MongoDB

2. **`MONGO_ROOT_PASSWORD`**: The password for the admin user
   - Default: `changeme`
   - **Change this to a strong password before first startup!**

3. **`MONGO_DATABASE`**: The name of the database to create
   - Default: `health`
   - This is the database where your health data will be stored

### First-Time Setup (Step-by-Step)

Follow these steps **IN ORDER** to initialize MongoDB:

#### Step 1: Configure Credentials (BEFORE starting MongoDB)

Copy the root example once (from `.env.example` in the repository root):
```env
cp .env.example .env
```

Edit `.env` and set your desired credentials:
```env
MONGO_ROOT_USERNAME=admin
MONGO_ROOT_PASSWORD=your-super-secure-password-here
MONGO_DATABASE=health
```

**Note**: These credentials will be used to create the admin user when MongoDB starts for the first time. You cannot change these after the database is initialized without recreating it.

#### Step 2: Start MongoDB for the First Time

```bash
cd infra
docker compose up -d
```

This will:
1. Download the MongoDB 7.0 Docker image (if not already downloaded)
2. Create Docker volumes for persistent storage
3. Start MongoDB
4. **Initialize the database** with the admin user specified in `.env`
5. Create the `health` database (though it will be empty)

#### Step 3: Verify MongoDB is Running

```bash
docker compose ps
```

You should see the `akita-mongodb` container in the "Up" state.

Check the logs to confirm successful initialization:
```bash
docker compose logs mongodb
```

Look for messages indicating MongoDB started successfully.

#### Step 4: Test the Connection

Connect to MongoDB using the credentials you set:
```bash
docker compose exec mongodb mongosh -u admin -p your-super-secure-password-here
```

Inside the MongoDB shell, verify the database exists:
```javascript
show dbs
use health
db.getName()
```

Type `exit` to leave the MongoDB shell.

---

## Database Collections

### How Collections are Created

**The collections are created automatically by the API** when it first inserts data. You do NOT need to manually create them.

When the API starts and receives its first data:
- `sleep_data` - Created when first sleep data is posted
- `mindful_minutes` - Created when first meditation data is posted
- `workouts` - Created when first workout data is posted
- `hourly_active_energy` - Created when first active energy data is posted

### Manual Collection Creation (Optional)

If you want to pre-create the collections (not required), you can do so via the MongoDB shell:

```bash
docker compose exec mongodb mongosh -u admin -p your-password
```

Then in the MongoDB shell:
```javascript
use health

// Create collections
db.createCollection("sleep_data")
db.createCollection("mindful_minutes")
db.createCollection("workouts")
db.createCollection("hourly_active_energy")

// Verify collections were created
show collections

exit
```

### Viewing Your Data

To browse the data stored in MongoDB:

```bash
docker-compose exec mongodb mongosh -u admin -p your-password
```

Inside the MongoDB shell:
```javascript
use health

// Show all collections
show collections

// Count documents in a collection
db.sleep_data.countDocuments()

// View recent sleep data (limit to 5 documents)
db.sleep_data.find().limit(5).pretty()

// View all workouts
db.workouts.find().pretty()

exit
```

---

## Connecting the API to MongoDB

### Connection String Format

The API needs to know how to connect to MongoDB. Configure this once in your repo `.env`.

**If you kept the default credentials (admin/changeme):**
```env
MONGODB_URI=mongodb://admin:changeme@localhost:27017/health?authSource=admin
```

**If you set custom credentials:**
```env
MONGODB_URI=mongodb://YOUR_USERNAME:YOUR_PASSWORD@localhost:27017/health?authSource=admin
```

Replace `YOUR_USERNAME` and `YOUR_PASSWORD` with the values you set in your repo-root `.env`.

### Connection String Breakdown

- `mongodb://` - MongoDB protocol
- `admin:changeme@` - Username and password (your root credentials)
- `localhost:27017` - Host and port where MongoDB is running
- `/health` - The database name
- `?authSource=admin` - Tells MongoDB to authenticate against the admin database

---

### Managing MongoDB

**Stop MongoDB:**
```bash
docker-compose stop
```

**Start MongoDB:**
```bash
docker-compose start
```

**Stop and remove containers (data persists in volumes):**
```bash
docker-compose down
```

**View logs:**
```bash
docker-compose logs -f mongodb
```

**Access MongoDB shell:**
```bash
docker-compose exec mongodb mongosh -u admin -p your-password
```

Replace `your-password` with your actual MongoDB password.

---

## Data Persistence

### How Data is Stored

Data is stored in Docker volumes that exist **independently** of the container:

- `mongodb_data`: Database files (your actual data)
- `mongodb_config`: MongoDB configuration files

### What This Means

- **Stopping the container** (`docker-compose stop`) does NOT delete your data
- **Removing the container** (`docker-compose down`) does NOT delete your data
- **Restarting your computer** does NOT delete your data
- Data persists until you explicitly delete the volumes

### Backing Up Data

To back up your MongoDB data:

```bash
# Create a backup directory
mkdir -p backups

# Dump all data from the health database
docker-compose exec -T mongodb mongosh -u admin -p your-password --quiet --eval "
  db.getSiblingDB('health').getCollectionNames().forEach(function(collection) {
    print('Backing up: ' + collection);
  })
"

# Or use mongodump for a complete backup
docker-compose exec mongodb mongodump -u admin -p your-password --db health --out /data/backup
```

### Resetting the Database

To completely remove all data and start fresh:

```bash
# Stop and remove containers AND volumes
docker-compose down -v

# Edit .env if you want to change credentials
nano .env

# Start fresh (will reinitialize with new credentials)
docker-compose up -d
```

**WARNING**: This will permanently delete all your health data!

---

## Troubleshooting

### "Authentication failed" errors

**Problem**: The API or MongoDB shell can't authenticate.

**Solution**: Make sure you're using the correct credentials:
1. Check what credentials you set in the repo `.env`
2. Use those same credentials in `MONGODB_URI` inside the repo `.env`
3. If you changed credentials after first startup, you need to reset the database (see "Resetting the Database" above)

### Can't connect to MongoDB from the API

**Problem**: API shows connection errors.

**Solution**:
1. Verify MongoDB is running: `docker-compose ps`
2. Check MongoDB logs: `docker-compose logs mongodb`
3. Verify your connection string in `api` (it reads from the repo `.env`) matches your Mongo credentials
4. Make sure you're using `localhost:27017` (not `127.0.0.1` or other variants)

### MongoDB won't start

**Problem**: Container exits immediately after starting.

**Solution**:
1. Check logs: `docker-compose logs mongodb`
2. Ensure port 27017 is not already in use: `lsof -i :27017`
3. If port is in use, stop the other MongoDB instance or change the port in `docker-compose.yml`

### Want to change credentials after initial setup

**Problem**: You already started MongoDB but want different credentials.

**Solution**: You must reset the database (this deletes all data):
```bash
docker-compose down -v
# Edit .env with new credentials
docker-compose up -d
```

---

## Quick Reference

### Common Commands

```bash
# Start MongoDB
docker-compose up -d

# Stop MongoDB (keeps data)
docker-compose stop

# View logs
docker-compose logs -f mongodb

# Access MongoDB shell
docker-compose exec mongodb mongosh -u admin -p your-password

# Restart MongoDB
docker-compose restart

# Check if MongoDB is running
docker-compose ps

# Complete teardown (deletes all data!)
docker-compose down -v
```

### MongoDB Shell Commands

Once connected to the MongoDB shell:

```javascript
// Switch to health database
use health

// Show all collections
show collections

// Count documents in a collection
db.sleep_data.countDocuments()

// View sample data
db.sleep_data.find().limit(5).pretty()

// Delete a specific document
db.sleep_data.deleteOne({ _id: ObjectId("...") })

// Drop entire collection (careful!)
db.sleep_data.drop()

// Exit shell
exit
```
