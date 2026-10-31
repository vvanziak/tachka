// Extracts the icons the web UI uses from the user's own Heroes III data (VCMI's Data folder) into ui/assets, which is git-ignored.
// Usage: npm run assets [-- <data dir> <vcmi checkout>]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const dataDir = process.argv[2] ?? join(homedir(), "Library/Application Support/vcmi/Data");
const vcmiDir = process.argv[3] ?? join(import.meta.dirname, "..", "..", "vcmi");
const out = join(import.meta.dirname, "..", "ui", "assets");

interface Image { width: number; height: number; rgba: Buffer }

// --- LOD archives: later archives override earlier ones
const files = new Map<string, () => Buffer>();
for(const lod of ["H3bitmap.lod", "H3sprite.lod", "H3ab_bmp.lod", "H3ab_spr.lod"]) {
	const path = join(dataDir, lod);
	if(!existsSync(path))
		continue;
	const b = readFileSync(path);
	const count = b.readUInt32LE(8);
	for(let i = 0; i < count; i++) {
		const o = 0x5c + i * 32;
		const name = b.toString("latin1", o, o + 16).replace(/\0.*$/, "").toLowerCase();
		const offset = b.readUInt32LE(o + 16), size = b.readUInt32LE(o + 20), packed = b.readUInt32LE(o + 28);
		files.set(name, () => packed ? inflateSync(b.subarray(offset, offset + packed)) : b.subarray(offset, offset + size));
	}
}
if(files.size === 0)
	throw new Error(`no .lod files in ${dataDir}`);

// --- PNG writer
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for(let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc(buf: Buffer): number {
	let c = 0xffffffff;
	for(const byte of buf)
		c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "latin1");
	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, tail]);
}
function png(image: Image): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(image.width, 0);
	header.writeUInt32BE(image.height, 4);
	header[8] = 8; header[9] = 6;
	const rows = Buffer.alloc((image.width * 4 + 1) * image.height);
	for(let y = 0; y < image.height; y++)
		image.rgba.copy(rows, y * (image.width * 4 + 1) + 1, y * image.width * 4, (y + 1) * image.width * 4);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

// --- PCX (the H3 variant: size, width, height, then 8-bit indexed pixels and a palette, or 24-bit BGR)
function pcx(data: Buffer): Image {
	const size = data.readUInt32LE(0), width = data.readUInt32LE(4), height = data.readUInt32LE(8);
	const rgba = Buffer.alloc(width * height * 4);
	for(let i = 0; i < width * height; i++) {
		if(size === width * height) {
			const p = 12 + size + data[12 + i]! * 3;
			rgba[i * 4] = data[p]!; rgba[i * 4 + 1] = data[p + 1]!; rgba[i * 4 + 2] = data[p + 2]!;
		}
		else {
			rgba[i * 4] = data[12 + i * 3 + 2]!; rgba[i * 4 + 1] = data[12 + i * 3 + 1]!; rgba[i * 4 + 2] = data[12 + i * 3]!;
		}
		rgba[i * 4 + 3] = 255;
	}
	return { width, height, rgba };
}

// --- DEF animations: every frame is placed on its full-size canvas; palette indexes 0 (transparent) and 1..4 (shadows) are made transparent
function def(data: Buffer): Image[] {
	const palette = data.subarray(16, 16 + 768);
	const frames: Image[] = [];
	let p = 16 + 768;
	const offsets: number[] = [];
	const blocks = data.readUInt32LE(12);
	for(let b = 0; b < blocks; b++) {
		const entries = data.readUInt32LE(p + 4);
		p += 16 + 13 * entries;
		for(let e = 0; e < entries; e++)
			offsets.push(data.readUInt32LE(p + e * 4));
		p += 4 * entries;
	}
	for(const base of offsets) {
		const format = data.readUInt32LE(base + 4);
		const fullWidth = data.readUInt32LE(base + 8), fullHeight = data.readUInt32LE(base + 12);
		const width = data.readUInt32LE(base + 16), height = data.readUInt32LE(base + 20);
		const x = data.readInt32LE(base + 24), y = data.readInt32LE(base + 28);
		const start = base + 32;
		const pixels = Buffer.alloc(width * height);
		const fill = (row: number, at: number, count: number, source: number) => { pixels.fill(source, row * width + at, row * width + at + count); };
		for(let row = 0; row < height; row++) {
			let at = 0;
			if(format === 0) {
				data.copy(pixels, row * width, start + row * width, start + (row + 1) * width);
				continue;
			}
			if(format === 1) {
				let q = start + data.readUInt32LE(start + row * 4);
				while(at < width) {
					const code = data[q++]!, length = data[q++]! + 1;
					if(code === 0xff) { data.copy(pixels, row * width + at, q, q + length); q += length; }
					else fill(row, at, length, code);
					at += length;
				}
			}
			else if(format === 2) {
				let q = start + data.readUInt16LE(start + row * 2);
				while(at < width) {
					const segment = data[q++]!, code = segment >> 5, length = (segment & 31) + 1;
					if(code === 7) { data.copy(pixels, row * width + at, q, q + length); q += length; }
					else fill(row, at, length, code);
					at += length;
				}
			}
			else if(format === 3) {
				const blocksPerRow = width >> 5;
				for(let blockIndex = 0; blockIndex < blocksPerRow; blockIndex++) {
					let q = start + data.readUInt16LE(start + (row * blocksPerRow + blockIndex) * 2);
					let got = 0;
					while(got < 32) {
						const segment = data[q++]!, code = segment >> 5, length = (segment & 31) + 1;
						if(code === 7) { data.copy(pixels, row * width + at, q, q + length); q += length; }
						else fill(row, at, length, code);
						at += length; got += length;
					}
				}
			}
		}
		const rgba = Buffer.alloc(fullWidth * fullHeight * 4);
		for(let row = 0; row < height; row++)
			for(let col = 0; col < width; col++) {
				const index = pixels[row * width + col]!;
				const target = ((y + row) * fullWidth + x + col) * 4;
				if(index <= 4 || x + col < 0 || y + row < 0 || x + col >= fullWidth || y + row >= fullHeight)
					continue;
				rgba[target] = palette[index * 3]!; rgba[target + 1] = palette[index * 3 + 1]!; rgba[target + 2] = palette[index * 3 + 2]!; rgba[target + 3] = 255;
			}
		frames.push({ width: fullWidth, height: fullHeight, rgba });
	}
	return frames;
}

// --- config helpers (JSON with // comments)
function config(path: string): Record<string, { index?: number; class?: string; female?: boolean; faction?: string }> {
	const source = readFileSync(path, "utf8");
	let text = "";
	for(let i = 0; i < source.length; i++) {
		const c = source[i]!;
		if(c === "\"") {
			let j = i + 1;
			while(source[j] !== "\"") j += source[j] === "\\" ? 2 : 1;
			text += source.slice(i, j + 1);
			i = j;
		}
		else if(c === "/" && source[i + 1] === "/")
			while(i < source.length && source[i] !== "\n") i++;
		else if(c === "/" && source[i + 1] === "*") {
			i = source.indexOf("*/", i + 2) + 1;
		}
		else
			text += c;
	}
	return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}

const manifest: { resources: string[]; creatures: string[]; heroes: Record<string, string>; towns: string[] } = { resources: [], creatures: [], heroes: {}, towns: [] };
const write = (rel: string, image: Image) => {
	mkdirSync(join(out, rel, ".."), { recursive: true });
	writeFileSync(join(out, rel), png(image));
};
const get = (name: string) => files.get(name.toLowerCase())?.();

// resources: RESOURCE.def frames in the order of config/resources.json
const resourceNames = ["wood", "mercury", "ore", "sulfur", "crystal", "gems", "gold"];
const resources = get("resource.def");
if(resources)
	def(resources).slice(0, resourceNames.length).forEach((image, i) => { write(`resources/${resourceNames[i]}.png`, image); manifest.resources.push(resourceNames[i]!); });

// creatures: CPRSMALL.def has the creature's index + 2 as the frame
const small = get("cprsmall.def");
if(small) {
	const frames = def(small);
	for(const file of readdirSync(join(vcmiDir, "config", "creatures"))) {
		for(const [id, creature] of Object.entries(config(join(vcmiDir, "config", "creatures", file)))) {
			const frame = creature.index === undefined ? undefined : frames[creature.index + 2];
			if(frame) { write(`creatures/${id.toLowerCase()}.png`, frame); manifest.creatures.push(id.toLowerCase()); }
		}
	}
}

// heroes: names are rows of HOTRAITS.TXT (row = hero index); portrait HPS<index><class code>
const classCodes: Record<string, string> = { knight: "KN", cleric: "CL", ranger: "RA", druid: "DR", alchemist: "AL", wizard: "WZ", demoniac: "DE", heretic: "HE", deathknight: "DK", necromancer: "NE", overlord: "OV", warlock: "WL", barbarian: "BA", battlemage: "BM", beastmaster: "BE", witch: "WI", planeswalker: "PL", elementalist: "EL" };
const traits = get("hotraits.txt");
if(traits) {
	const names = traits.toString("latin1").split("\r\n").slice(2).map(line => line.split("\t")[0]!);
	for(const file of readdirSync(join(vcmiDir, "config", "heroes"))) {
		if(file.startsWith("portraits"))
			continue;
		for(const hero of Object.values(config(join(vcmiDir, "config", "heroes", file)))) {
			if(hero.index === undefined || hero.index >= names.length)
				continue;
			const number = String(hero.index).padStart(3, "0");
			const code = classCodes[(hero.class ?? "").toLowerCase()];
			const data = (code && get(`hps${number}${code}.pcx`)) ?? [...files.keys()].filter(n => n.startsWith(`hps${number}`)).map(n => get(n))[0];
			if(data) {
				const key = names[hero.index]!.toLowerCase();
				write(`heroes/${key}.png`, pcx(data));
				manifest.heroes[key] = `heroes/${key}.png`;
			}
		}
	}
}

// towns: ITPT.def, two frames per faction in the original faction order; the second one carries a red cross
const factions = ["castle", "rampart", "tower", "inferno", "necropolis", "dungeon", "stronghold", "fortress", "conflux"];
const towns = get("itpt.def");
if(towns) {
	const frames = def(towns);
	factions.forEach((faction, i) => {
		const frame = frames[i * 2];
		if(frame) { write(`towns/${faction}.png`, frame); manifest.towns.push(faction); }
	});
}

writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
console.log(`wrote ${manifest.resources.length} resources, ${manifest.creatures.length} creatures, ${Object.keys(manifest.heroes).length} heroes, ${manifest.towns.length} towns to ${out}`);
