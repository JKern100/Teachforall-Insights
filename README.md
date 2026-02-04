# Teach For All Insight - Local Version

A local Node.js application that replaces the Google Apps Script version of the Teach For All Knowledge Q&A system.

## Features

- 🤖 **AI Q&A** - Ask questions about your meetings and notes using Gemini AI
- 📄 **Weekly Reports** - View partner reports from Supabase
- 🔍 **Transcript Search** - Search and query local transcript files
- 📝 **Add Notes** - Save notes directly to Supabase

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Edit the `.env` file and add your **Gemini API Key**:

```
GEMINI_API_KEY=your_actual_gemini_api_key_here
```

The Supabase credentials are already included from your original app.

### 3. Create Transcripts Folder

```bash
mkdir transcripts
```

Place your transcript files (`.txt`, `.vtt`, `.srt`) in this folder. The system will search through subdirectories.

### 4. Start the Server

```bash
npm start
```

Or for development with auto-restart:

```bash
npm run dev
```

### 5. Open the Application

Visit http://localhost:3000 in your browser.

## Key Differences from Google Apps Script

| Feature | Google Apps Script | Local Version |
|---------|-------------------|---------------|
| **API Calls** | `UrlFetchApp` | `axios` |
| **File Storage** | Google Drive | Local filesystem |
| **Configuration** | Script Properties | Environment variables |
| **Frontend** | JSONP to Google Apps | Fetch to local API |
| **Transcripts** | Google Drive files | Local files in `./transcripts` |

## API Endpoints

- `GET /api?action=ask` - Ask AI questions
- `GET /api?action=getreports` - Get weekly reports  
- `GET /api?action=findtranscripts` - Search local transcripts
- `GET /api?action=asktranscript` - Ask about a specific transcript
- `GET /api?action=addnote` - Add note to Supabase

## File Structure

```
TFAllInsight/
├── server.js              # Main Node.js server
├── package.json            # Dependencies and scripts
├── .env                    # Environment variables
├── public/
│   └── index.html          # Frontend application
├── transcripts/            # Your transcript files
└── README.md               # This file
```

## Troubleshooting

### "Missing GEMINI_API_KEY" Error
- Make sure you've added your Gemini API key to the `.env` file
- Get a key from: https://aistudio.google.com/app/apikey

### "Transcripts folder not found" Error
- Create the `transcripts` folder in the project root
- Add your `.txt`, `.vtt`, or `.srt` files to this folder

### Supabase Connection Issues
- Verify your Supabase URL and key are correct in `.env`
- Check that your Supabase project is active

## Development

The server includes detailed logging and error handling. All API responses include debug information to help troubleshoot issues.

## License

MIT
