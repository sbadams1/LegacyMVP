import json
from google.cloud import speech
from google.oauth2 import service_account

# Load your service account JSON
SERVICE_ACCOUNT_FILE = 'assets/google_speech.json'  # Path to your file

credentials = service_account.Credentials.from_service_account_file(
    SERVICE_ACCOUNT_FILE,
    scopes=['https://www.googleapis.com/auth/cloud-platform']
)

client = speech.SpeechClient(credentials=credentials)

# Test with Google's sample audio
audio = speech.RecognitionAudio(uri="gs://cloud-samples-tests/speech/brooklyn.flac")
config = speech.RecognitionConfig(
    encoding=speech.RecognitionConfig.AudioEncoding.FLAC,
    sample_rate_hertz=16000,
    language_code="en-US",
)

request = speech.RecognizeRequest(config=config, audio=audio)

try:
    response = client.recognize(request=request)
    if response.results:
        print("✅ ACCESS CONFIRMED: " + response.results[0].alternatives[0].transcript)
    else:
        print("❌ No speech detected (but access OK)")
except Exception as e:
    print("❌ ACCESS DENIED: " + str(e))