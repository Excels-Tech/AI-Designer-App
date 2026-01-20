
const fetch = require('node-fetch');

async function testGenerate() {
    const url = 'http://localhost:4000/api/image/generate';
    console.log('Fetching:', url);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: 'a futuristic city with flying cars at sunset',
                width: 1024,
                height: 1024,
                platform: 'Test',
                designType: 'post'
            }),
        });

        if (!res.ok) {
            const txt = await res.text();
            console.error('Error:', res.status, txt);
            return;
        }

        const data = await res.json();
        console.log('Success:', JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Fetch failed:', err);
    }
}

testGenerate();
