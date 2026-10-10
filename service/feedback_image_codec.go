package service

import (
	"bytes"
	"context"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path"

	"github.com/disintegration/imaging"
	_ "golang.org/x/image/webp"
)

const feedbackThumbnailMaxBytes = 2 * 1024 * 1024

func (s *FeedbackImageStore) processImage(ctx context.Context, img *stagedFeedbackImage) error {
	f, err := s.root.Open(path.Join(img.dir, "input"))
	if err != nil {
		return ErrFeedbackImageStore
	}
	raw, readErr := io.ReadAll(io.LimitReader(feedbackContextReader{ctx, f}, FeedbackMaxImageBytes+1))
	f.Close()
	if readErr != nil {
		return readErr
	}
	if len(raw) > FeedbackMaxImageBytes {
		return ErrFeedbackImageLimit
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "jpeg" && format != "png" && format != "webp") {
		return ErrFeedbackImageFormat
	}
	if config.Width < 1 || config.Height < 1 || config.Width > 8192 || config.Height > 8192 || int64(config.Width)*int64(config.Height) > 20_000_000 {
		return ErrFeedbackImageLimit
	}
	orientation, err := feedbackImageOrientation(raw, format)
	if err != nil {
		return err
	}
	decoded, decodedFormat, err := image.Decode(bytes.NewReader(raw))
	if err != nil || format != decodedFormat || decoded.Bounds().Dx() != config.Width || decoded.Bounds().Dy() != config.Height {
		return ErrFeedbackImageFormat
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	decoded = orientFeedbackImage(decoded, orientation)
	img.row.MIMEType = "image/" + format
	img.row.Width, img.row.Height = decoded.Bounds().Dx(), decoded.Bounds().Dy()
	ext, _ := feedbackImageExtension(img.row.MIMEType)
	if err := s.root.Rename(path.Join(img.dir, "input"), path.Join(img.dir, "original."+ext)); err != nil {
		return ErrFeedbackImageStore
	}
	// Fit does not enlarge smaller images, preserves aspect ratio and alpha.
	thumb := imaging.Fit(decoded, 512, 512, imaging.Lanczos)
	var encoded bytes.Buffer
	if thumb.Opaque() {
		img.row.ThumbnailMIMEType = "image/jpeg"
		err = jpeg.Encode(&encoded, thumb, &jpeg.Options{Quality: 85})
	} else {
		img.row.ThumbnailMIMEType = "image/png"
		err = png.Encode(&encoded, thumb)
	}
	if err != nil || encoded.Len() > feedbackThumbnailMaxBytes {
		return ErrFeedbackImageStore
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	ext, _ = feedbackImageExtension(img.row.ThumbnailMIMEType)
	thumbFile, err := s.root.OpenFile(path.Join(img.dir, "thumbnail."+ext), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return ErrFeedbackImageStore
	}
	_, writeErr := thumbFile.Write(encoded.Bytes())
	syncErr := thumbFile.Sync()
	closeErr := thumbFile.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return ErrFeedbackImageStore
	}
	img.row.ThumbnailByteSize = int64(encoded.Len())
	if err := s.syncDirectory(img.dir); err != nil {
		return ErrFeedbackImageStore
	}
	return nil
}

func orientFeedbackImage(img image.Image, orientation int) image.Image {
	switch orientation {
	case 2:
		return imaging.FlipH(img)
	case 3:
		return imaging.Rotate180(img)
	case 4:
		return imaging.FlipV(img)
	case 5:
		return imaging.Transpose(img)
	case 6:
		return imaging.Rotate270(img)
	case 7:
		return imaging.Transverse(img)
	case 8:
		return imaging.Rotate90(img)
	default:
		return img
	}
}

// Validate every container chunk, including ancillary chunks after pixel data.
// The standard raster decoders alone can accept the first frame of APNG/WebP.
func feedbackImageOrientation(raw []byte, format string) (int, error) {
	orientation := 1
	seenOrientation := false
	readExif := func(rawExif []byte) error {
		value, err := feedbackExifOrientation(rawExif)
		if err != nil {
			return err
		}
		if seenOrientation && orientation != value {
			return ErrFeedbackImageFormat
		}
		orientation, seenOrientation = value, true
		return nil
	}
	switch format {
	case "jpeg":
		if len(raw) < 4 || raw[0] != 0xff || raw[1] != 0xd8 || !bytes.HasSuffix(raw, []byte{0xff, 0xd9}) {
			return 0, ErrFeedbackImageFormat
		}
		for pos := 2; pos < len(raw); {
			if raw[pos] != 0xff {
				return 0, ErrFeedbackImageFormat
			}
			for pos < len(raw) && raw[pos] == 0xff {
				pos++
			}
			if pos >= len(raw) {
				return 0, ErrFeedbackImageFormat
			}
			marker := raw[pos]
			pos++
			if marker == 0xda || marker == 0xd9 {
				break
			}
			if marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7) {
				continue
			}
			if pos+2 > len(raw) {
				return 0, ErrFeedbackImageFormat
			}
			size := int(binary.BigEndian.Uint16(raw[pos : pos+2]))
			if size < 2 || size > len(raw)-pos {
				return 0, ErrFeedbackImageFormat
			}
			if marker == 0xe1 && bytes.HasPrefix(raw[pos+2:pos+size], []byte("Exif\x00\x00")) {
				if err := readExif(raw[pos+2 : pos+size]); err != nil {
					return 0, err
				}
			}
			pos += size
		}
	case "png":
		if len(raw) < 8 || string(raw[:8]) != "\x89PNG\r\n\x1a\n" {
			return 0, ErrFeedbackImageFormat
		}
		ended := false
		for pos := 8; pos < len(raw); {
			if len(raw)-pos < 12 {
				return 0, ErrFeedbackImageFormat
			}
			size := int64(binary.BigEndian.Uint32(raw[pos : pos+4]))
			if size > int64(len(raw)-pos-12) {
				return 0, ErrFeedbackImageFormat
			}
			end := pos + 8 + int(size)
			chunk := string(raw[pos+4 : pos+8])
			if crc32.ChecksumIEEE(raw[pos+4:end]) != binary.BigEndian.Uint32(raw[end:end+4]) {
				return 0, ErrFeedbackImageFormat
			}
			switch chunk {
			case "acTL", "fcTL", "fdAT":
				return 0, ErrFeedbackImageFormat
			case "eXIf":
				if err := readExif(raw[pos+8 : end]); err != nil {
					return 0, err
				}
			case "IEND":
				if size != 0 || end+4 != len(raw) {
					return 0, ErrFeedbackImageFormat
				}
				ended = true
			}
			pos = end + 4
		}
		if !ended {
			return 0, ErrFeedbackImageFormat
		}
	case "webp":
		if len(raw) < 12 || string(raw[:4]) != "RIFF" || string(raw[8:12]) != "WEBP" || int64(binary.LittleEndian.Uint32(raw[4:8]))+8 != int64(len(raw)) {
			return 0, ErrFeedbackImageFormat
		}
		for pos := 12; pos < len(raw); {
			if len(raw)-pos < 8 {
				return 0, ErrFeedbackImageFormat
			}
			size := int64(binary.LittleEndian.Uint32(raw[pos+4 : pos+8]))
			padded := size + (size & 1)
			if padded > int64(len(raw)-pos-8) {
				return 0, ErrFeedbackImageFormat
			}
			end := pos + 8 + int(size)
			switch string(raw[pos : pos+4]) {
			case "ANIM", "ANMF":
				return 0, ErrFeedbackImageFormat
			case "VP8X":
				if size != 10 || raw[pos+8]&0x02 != 0 {
					return 0, ErrFeedbackImageFormat
				}
			case "EXIF":
				if err := readExif(raw[pos+8 : end]); err != nil {
					return 0, err
				}
			}
			pos += 8 + int(padded)
		}
	default:
		return 0, ErrFeedbackImageFormat
	}
	return orientation, nil
}

func feedbackExifOrientation(exif []byte) (int, error) {
	if bytes.HasPrefix(exif, []byte("Exif\x00\x00")) {
		exif = exif[6:]
	}
	if len(exif) < 8 {
		return 0, ErrFeedbackImageFormat
	}
	var order binary.ByteOrder
	switch string(exif[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0, ErrFeedbackImageFormat
	}
	if order.Uint16(exif[2:4]) != 42 {
		return 0, ErrFeedbackImageFormat
	}
	offset := int64(order.Uint32(exif[4:8]))
	if offset < 8 || offset > int64(len(exif)-2) {
		return 0, ErrFeedbackImageFormat
	}
	count := int64(order.Uint16(exif[offset : offset+2]))
	if count > (int64(len(exif))-offset-2)/12 {
		return 0, ErrFeedbackImageFormat
	}
	for i := int64(0); i < count; i++ {
		entry := exif[offset+2+12*i : offset+2+12*(i+1)]
		if order.Uint16(entry[:2]) != 0x0112 {
			continue
		}
		if order.Uint16(entry[2:4]) != 3 || order.Uint32(entry[4:8]) != 1 {
			return 0, ErrFeedbackImageFormat
		}
		value := int(order.Uint16(entry[8:10]))
		if value < 1 || value > 8 {
			return 0, ErrFeedbackImageFormat
		}
		return value, nil
	}
	return 1, nil
}
