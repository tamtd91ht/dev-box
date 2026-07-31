import type { Metadata } from 'next';
import 'react-datepicker/dist/react-datepicker.css';
import './globals.css';
import ZaloChat from '@/components/ZaloChat';
import SuppressAutofill from '@/components/SuppressAutofill';

export const metadata: Metadata = {
  title: 'VHS DevBox',
  description: 'Infra toolbox dùng chung — Redis, Kafka, RabbitMQ, MongoDB, Elasticsearch, PostgreSQL, Git, Webhooks.',
};

// Set the theme before first paint to avoid a flash of the wrong theme.
const themeInit = `(function(){try{var t=localStorage.getItem('apitester.theme')||'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        {children}
        <SuppressAutofill />
        <ZaloChat />
      </body>
    </html>
  );
}
