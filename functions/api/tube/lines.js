// GET /api/tube/lines
//
// The tube (+ DLR, Overground, Elizabeth) lines, each with its official colour.
// Static because lines rarely change — no TfL round-trip needed for the picker.

const LINES = [
  { id: "bakerloo", name: "Bakerloo", colour: "#B36305" },
  { id: "central", name: "Central", colour: "#E32017" },
  { id: "circle", name: "Circle", colour: "#FFD300" },
  { id: "district", name: "District", colour: "#00782A" },
  { id: "hammersmith-city", name: "Hammersmith & City", colour: "#F3A9BB" },
  { id: "jubilee", name: "Jubilee", colour: "#A0A5A9" },
  { id: "metropolitan", name: "Metropolitan", colour: "#9B0056" },
  { id: "northern", name: "Northern", colour: "#000000" },
  { id: "piccadilly", name: "Piccadilly", colour: "#003688" },
  { id: "victoria", name: "Victoria", colour: "#0098D4" },
  { id: "waterloo-city", name: "Waterloo & City", colour: "#95CDBA" },
  { id: "elizabeth", name: "Elizabeth line", colour: "#6950A1" },
  { id: "dlr", name: "DLR", colour: "#00A4A7" },
  { id: "liberty", name: "Liberty", colour: "#5D6061" },
  { id: "lioness", name: "Lioness", colour: "#F1B41C" },
  { id: "mildmay", name: "Mildmay", colour: "#0077AD" },
  { id: "suffragette", name: "Suffragette", colour: "#61B14D" },
  { id: "weaver", name: "Weaver", colour: "#823A62" },
  { id: "windrush", name: "Windrush", colour: "#EE2E24" },
];

export async function onRequest() {
  return new Response(JSON.stringify({ lines: LINES }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
