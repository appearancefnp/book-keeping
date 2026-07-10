'use client';
export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" className="print-btn" onClick={() => window.print()}
      style={{ display: 'block', margin: '16px auto', padding: '8px 16px' }}>
      {label}
    </button>
  );
}
