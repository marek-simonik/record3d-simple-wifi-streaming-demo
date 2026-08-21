// https://developer.mozilla.org/en-US/docs/Web/API/RTCEncodedVideoFrame/getMetadata

function ebsp2rbsp(ebspData) {
    let rbsp = new Uint8Array( ebspData.byteLength );

    let numConsecutiveZeros = 0;
    let rbspIdx = 0;

    for ( let ebspIdx = 0; ebspIdx < ebspData.byteLength; ebspIdx++ ) {
        let currByte = ebspData.getUint8( ebspIdx );

        if ( !( currByte === 0x03 && numConsecutiveZeros >= 2 ) ) {
            rbsp[rbspIdx] = currByte;
            rbspIdx++;
        }

        if ( currByte === 0x00 ) {
            numConsecutiveZeros++;
        } else {
            numConsecutiveZeros = 0;
        }
    }

    return rbsp.subarray( 0, rbspIdx );
}

function extractMetadataFromSeiPayload(byteArray) {
    // Should start with payloadSize bytes (0xFF, 0xFF, ..., 0x41)
    var offset = 0;

    // Skip the payloadSize
    while ( byteArray[offset++] === 0xFF ) ;

    // Skip the 16 bytes of UUID
    const uuidLength = 16;
    offset += uuidLength;

    var finalMetadata = new Uint8Array( byteArray.length - offset - 1 /* -1 for the ending 0x80 byte */ );

    for ( let i = 0; i < finalMetadata.length; i++ ) {
        finalMetadata[i] = byteArray[offset + i];
    }

    return finalMetadata;
}

addEventListener( "rtctransform", (event) => {
    const transform = new TransformStream( {
        start() { }, // Called on startup
        flush() { }, // Called when the stream is about to be closed

        async transform(encodedFrame, controller) {
            // Reconstruct the original frame.
            const view = new DataView( encodedFrame.data );

            const metadataSegmentStartBytes = new Uint8Array( [0x00, 0x00, 0x00, 0x01, 0x06, 0x05] );
            let unregisteredSeiMessagePreambleSizeInBytes = metadataSegmentStartBytes.byteLength;
            let offsetToSeiStart = -1;

            // Find the first occurrence of that byte sequence in the encoded frame; search from the end
            for ( offsetToSeiStart = encodedFrame.data.byteLength - 1 - unregisteredSeiMessagePreambleSizeInBytes; offsetToSeiStart >= 0; offsetToSeiStart-- ) {
                let didFindSegment = true;

                for ( let i = 0; i < unregisteredSeiMessagePreambleSizeInBytes; i++ ) {
                    if ( view.getInt8( offsetToSeiStart + i ) !== metadataSegmentStartBytes[i] ) {
                        didFindSegment = false;
                        break;
                    }
                }

                if ( didFindSegment ) {
                    break;
                }
            }

            let appMetadata = {};

            if ( offsetToSeiStart <= 0 ) {
                console.error( 'ERROR! Could NOT find the SEI message!' );
                return;

            } else {
                // Skip the start code, the NAL header, and the payloadType
                let offsetToSeiPayloadSize = offsetToSeiStart + metadataSegmentStartBytes.byteLength;

                var ebsp = new DataView( encodedFrame.data, offsetToSeiPayloadSize, encodedFrame.data.byteLength - offsetToSeiPayloadSize );
                var rbsp = ebsp2rbsp( ebsp ); // This should start with the payloadSize bytes
                var finalPayload = extractMetadataFromSeiPayload( rbsp );

                // The metadata is expected to contain a JSON string
                const str = new TextDecoder().decode( finalPayload );
                appMetadata = JSON.parse( str );
            }

            // Post message to the main thread
            let videoMetadata = encodedFrame.getMetadata();
            let rtpTimestamp = videoMetadata.rtpTimestamp;

            let metadataMessage = {
                frameTimestamp: rtpTimestamp,
                metadata: appMetadata
            };

            postMessage( metadataMessage );

            // Remove the metadata from the encoded video frame (not necessary for H.264, but required for other codecs)
            encodedFrame.data = encodedFrame.data.slice(0, offsetToSeiStart);
            controller.enqueue( encodedFrame );
        }
    } );

    event.transformer.readable
        .pipeThrough( transform )
        .pipeTo( event.transformer.writable );
} );