
# learn you some face

A spaced-repetition flashcard game for learning Recurse Center participants' names and faces.

## Setup

### 1. Create an RC OAuth app

Go to [recurse.com/settings/oauth](https://www.recurse.com/settings/oauth) and create a new application. Set the redirect URI to `http://localhost:3000/auth/callback`.

### 2. Configure environment

Create a `.env` file:

```
RC_CLIENT_ID=your_client_id
RC_CLIENT_SECRET=your_client_secret
SESSION_SECRET=a_random_secret_string
# REDIRECT_URI=http://localhost:3000/auth/callback  (optional, this is the default)
```

### 3. Run

```sh
npm install
npm run dev   # starts Express server at http://localhost:3000
```

Open [localhost:3000](http://localhost:3000) and log in with your RC account.
