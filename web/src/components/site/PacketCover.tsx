import { useState } from 'react'
import { DEFAULT_PACKET_COVER, validPacketCover } from '@/lib/redPacket'

export function PacketCover({ url, className }: { url?: string; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  const src = url && validPacketCover(url) && failed !== url ? url : DEFAULT_PACKET_COVER
  return <img src={src} width={720} height={1080} alt="" className={className} onError={() => setFailed(url ?? '')} />
}
