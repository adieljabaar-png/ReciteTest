const fs = require('fs');
const JavaScriptObfuscator = require('javascript-obfuscator');

// Read your source index.html file
const sourceFile = 'index.html';
const outputFile = 'index.production.html';

if (!fs.existsSync(sourceFile)) {
    console.error(`Error: ${sourceFile} not found in the current directory.`);
    process.exit(1);
}

let htmlContent = fs.readFileSync(sourceFile, 'utf8');

// Find and obfuscate inline script blocks
htmlContent = htmlContent.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (match, scriptContent) => {
    // Skip external script tags (e.g., libraries loaded via CDN with a src attribute)
    if (match.includes('src=')) {
        return match;
    }
    if (!scriptContent.trim()) {
        return match;
    }

    console.log('🔒 Obfuscating inline script block...');

    const obfuscatedResult = JavaScriptObfuscator.obfuscate(scriptContent, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75, // Flattens logic into complex state machines
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.4,     // Injects decoy code to confuse reverse-engineering
        stringArray: true,
        stringArrayEncoding: ['base64'],     // Encodes all string literals (selectors, texts, keys)
        stringArrayThreshold: 0.75,
        identifierNamesGenerator: 'hexadecimal', // Replaces readable variable names with hex codes
        renameGlobals: false
    });

    return `<script>\n${obfuscatedResult.getObfuscatedCode()}\n</script>`;
});

// Write out the protected production file
fs.writeFileSync(outputFile, htmlContent, 'utf8');
console.log(`✅ Success! Protected build saved to ${outputFile}`);
