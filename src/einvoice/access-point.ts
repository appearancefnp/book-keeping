export interface AccessPoint {
  send(ublXml: string, recipient: string): Promise<{ messageId: string }>;
  receive(): Promise<{ ublXml: string }[]>;
}

/** In-memory sandbox Access Point for tests. */
export class StubAccessPoint implements AccessPoint {
  public sent: { ublXml: string; recipient: string }[] = [];
  private inbox: { ublXml: string }[];
  private seq = 0;
  constructor(inbox: { ublXml: string }[] = []) { this.inbox = inbox; }
  async send(ublXml: string, recipient: string): Promise<{ messageId: string }> {
    this.sent.push({ ublXml, recipient });
    this.seq += 1;
    return { messageId: `stub-msg-${this.seq}` };
  }
  async receive(): Promise<{ ublXml: string }[]> {
    const batch = this.inbox;
    this.inbox = [];
    return batch;
  }
}
