// src/utils/legalContent.ts
// Shared legal content for AgreementScreen (desktop) and MobileAgreementScreen.
// Keeping data separate from presentation avoids cross-component imports
// between the desktop and mobile trees.

export const AGREEMENT_KEY   = "rift-agreement-v1";
export const EFFECTIVE_DATE  = "2025";
export const DEVELOPER_EMAIL = "eldergod263@gmail.com";

export interface LegalSection {
  heading:    string;
  paragraphs: string[];
  bullets?:   string[];
}

export const LEGAL_SECTIONS: LegalSection[] = [
  {
    heading: "1. About The Rift",
    paragraphs: [
      "The Rift is a peer-to-peer, local-area network (LAN) file and text transfer utility created by abyssprotocol. It transfers data directly between devices on the same private Wi-Fi network or personal hotspot. No internet connection is used or required at any point. No external servers are contacted. No account is needed to use the app.",
    ],
  },
  {
    heading: "2. Privacy Policy — Data We Collect",
    paragraphs: [
      "The Rift collects no data of any kind. abyssprotocol has zero access to any information about you, your files, your device, or your network. Specifically:",
    ],
    bullets: [
      "No personal information is collected, stored, or transmitted.",
      "No file names, file contents, or file metadata are sent to any server.",
      "No usage analytics, crash reports, diagnostics, or telemetry are gathered.",
      "No device identifiers, IP addresses, or network topology data are shared with any third party.",
      "No advertising SDKs, tracking libraries, or analytics frameworks are present in the app.",
      "All file and text transfer data travels exclusively between the two devices you select, inside your local network only.",
    ],
  },
  {
    heading: "3. Local Network Discovery",
    paragraphs: [
      "To locate other devices running The Rift on your network, the app broadcasts small, standardised discovery packets (mDNS and UDP) within your local broadcast domain. These signals are confined to your local network and are never routed to the internet or to any server controlled by abyssprotocol. Discovery activity begins on app launch and ceases when the app is closed.",
    ],
  },
  {
    heading: "4. Your Responsibilities",
    paragraphs: [
      "By using The Rift, you accept full, sole responsibility for:",
    ],
    bullets: [
      "All files, folders, and text content you choose to send or receive.",
      "Confirming that you hold the legal right to transfer any file you send.",
      "The security and access controls of your local network.",
      "Any device you choose to connect to or accept a transfer request from.",
    ],
  },
  {
    heading: "5. Prohibited Uses",
    paragraphs: [
      "You agree not to use The Rift to:",
    ],
    bullets: [
      "Transfer files that violate any applicable law, regulation, or court order.",
      "Distribute malware, ransomware, spyware, viruses, or any other harmful software.",
      "Infringe any copyright, trademark, patent, or other intellectual property right.",
      "Share any content that sexualises, exploits, endangers, or abuses minors in any form.",
      "Harass, stalk, surveil, or otherwise violate the privacy or dignity of any person.",
      "Facilitate, plan, or execute any criminal or tortious activity.",
    ],
  },
  {
    heading: "6. Disclaimer of Warranties",
    paragraphs: [
      "The Rift is provided \"AS IS\" and \"AS AVAILABLE\" without any warranty of any kind, express or implied. abyssprotocol makes no representations regarding merchantability, fitness for a particular purpose, accuracy, reliability, or uninterrupted operation. You use The Rift entirely at your own risk.",
    ],
  },
  {
    heading: "7. Limitation of Liability",
    paragraphs: [
      "To the fullest extent permitted by applicable law, abyssprotocol shall not be liable for any direct, indirect, incidental, special, consequential, or exemplary damages arising from or related to your use of, or inability to use, The Rift. This includes without limitation loss of data, file corruption, network disruption, device damage, or any commercial loss.",
    ],
  },
  {
    heading: "8. Intellectual Property",
    paragraphs: [
      "The Rift — including its interface design, source code, visual language, and branding — is the intellectual property of abyssprotocol. You are granted a limited, personal, non-exclusive, non-transferable, revocable licence to install and use The Rift on your own devices for personal, non-commercial purposes. You may not copy, modify, distribute, sublicense, sell, or reverse-engineer any portion of The Rift without prior written consent from abyssprotocol.",
    ],
  },
  {
    heading: "9. Age Requirement",
    paragraphs: [
      "The Rift is not directed at children under the age of 13. By accepting these terms, you confirm that you are at least 13 years of age, or that you have obtained the verifiable parental or guardian consent required by the laws of your jurisdiction.",
    ],
  },
  {
    heading: "10. Changes to This Agreement",
    paragraphs: [
      "abyssprotocol reserves the right to revise these Terms and Privacy Policy at any time. When material changes are made, the updated agreement will be presented within the app at next launch and will require your fresh acceptance before you can continue. Continued use of The Rift after accepting an updated agreement constitutes your agreement to the revised terms.",
    ],
  },
  {
    heading: "11. Governing Law & Severability",
    paragraphs: [
      "These Terms are governed by and construed in accordance with applicable law in your jurisdiction. If any provision of these Terms is held to be unenforceable or invalid by a court of competent jurisdiction, that provision will be limited or eliminated to the minimum extent necessary, and the remaining provisions will continue in full force and effect.",
    ],
  },
  {
    heading: "12. Contact",
    paragraphs: [
      `For questions, concerns, or support relating to The Rift or these Terms, contact abyssprotocol at: ${DEVELOPER_EMAIL}`,
    ],
  },
];