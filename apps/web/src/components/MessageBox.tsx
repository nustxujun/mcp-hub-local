import React, { createContext, useContext, useState, useCallback, useRef } from 'react';

interface MessageBoxState {
  visible: boolean;
  message: string;
  mode: 'alert' | 'confirm';
}

interface MessageBoxContextValue {
  alert: (message: string) => Promise<void>;
  confirm: (message: string) => Promise<boolean>;
}

const MessageBoxContext = createContext<MessageBoxContextValue | null>(null);

export function useMessageBox(): MessageBoxContextValue {
  const ctx = useContext(MessageBoxContext);
  if (!ctx) throw new Error('useMessageBox must be used within MessageBoxProvider');
  return ctx;
}

export function MessageBoxProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MessageBoxState>({ visible: false, message: '', mode: 'alert' });
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const show = useCallback((message: string, mode: 'alert' | 'confirm'): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setState({ visible: true, message, mode });
    });
  }, []);

  const close = useCallback((result: boolean) => {
    setState(s => ({ ...s, visible: false }));
    resolveRef.current?.(result);
    resolveRef.current = null;
  }, []);

  const contextValue: MessageBoxContextValue = {
    alert: useCallback((message: string) => show(message, 'alert').then(() => {}), [show]),
    confirm: useCallback((message: string) => show(message, 'confirm'), [show]),
  };

  return (
    <MessageBoxContext.Provider value={contextValue}>
      {children}
      {state.visible && (
        <div className="modal-overlay" onClick={() => close(false)} style={{ zIndex: 200 }}>
          <div className="modal msgbox" onClick={e => e.stopPropagation()}>
            <pre className="msgbox-body">{state.message}</pre>
            <div className="modal-actions">
              {state.mode === 'confirm' && (
                <button className="btn btn-ghost" onClick={() => close(false)}>Cancel</button>
              )}
              <button className="btn btn-primary" onClick={() => close(true)} autoFocus>OK</button>
            </div>
          </div>
        </div>
      )}
    </MessageBoxContext.Provider>
  );
}
