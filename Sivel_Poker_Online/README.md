# Sivel Poker Online

A private browser-based Texas Hold’em game for 2–6 players. Players only need the final website link—no downloads, Node.js, or account required.

## Deploy on Render

1. Create a new empty GitHub repository.
2. Upload `server.js`, `package.json`, `render.yaml`, `.gitignore`, and the `public` folder to the repository root.
3. In Render, choose **New → Blueprint**, connect the repository, and deploy the included `render.yaml`.
4. Open the generated `onrender.com` address. Players can create a private room and share its invite link or room code.

## Notes

- Room state is held in server memory. Active rooms survive ordinary browser refreshes but reset if the hosting service restarts or redeploys.
- Render’s free web service can spin down after inactivity. The first visitor after a spin-down may see a startup delay.
- Use a paid always-on instance later if you want instant startup and more reliable long-running rooms.

## Health check

`GET /api/health`
