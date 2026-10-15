import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

final class SystemAudioOutput: NSObject, SCStreamOutput {
    private let output = FileHandle.standardOutput
    private var reportedFormat = false

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid,
              let description = sampleBuffer.formatDescription else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
                var audioBufferList = AudioBufferList(mNumberBuffers: 1,
                        mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: 0, mData: nil))
                var retainedBlock: CMBlockBuffer?
                let bufferStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer,
                        bufferListSizeNeededOut: nil, bufferListOut: &audioBufferList,
                        bufferListSize: MemoryLayout<AudioBufferList>.size,
                        blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
                        flags: 0, blockBufferOut: &retainedBlock)
        guard format.commonFormat == .pcmFormatFloat32, format.sampleRate == 16000,
                            format.channelCount == 1, bufferStatus == noErr, audioBufferList.mNumberBuffers == 1,
                            let data = audioBufferList.mBuffers.mData else {
            if !reportedFormat {
                reportedFormat = true
                                FileHandle.standardError.write(Data("Unexpected system audio buffer (\(bufferStatus)): \(format)\n".utf8))
            }
            return
        }
                let frames = Int(audioBufferList.mBuffers.mDataByteSize) / MemoryLayout<Float32>.stride
        guard frames > 0 else { return }
        let channels = data.assumingMemoryBound(to: Float32.self)
        var pcm = Data(count: frames * 2)
        pcm.withUnsafeMutableBytes { bytes in
            let samples = bytes.bindMemory(to: Int16.self)
            for index in 0..<frames {
                let value = channels[index]
                samples[index] = value.isFinite ? Int16(max(-32768, min(32767, Int(value * 32767)))) : 0
            }
        }
        output.write(pcm)
    }
}

final class SystemAudioCapture {
    private var stream: SCStream?
    private let handler = SystemAudioOutput()
    private let queue = DispatchQueue(label: "meetingassistant.systemAudio")

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { throw NSError(domain: "SystemAudio", code: 1) }
        let configuration = SCStreamConfiguration()
        configuration.width = 2
        configuration.height = 2
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 16000
        configuration.channelCount = 1
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []),
                              configuration: configuration, delegate: nil)
        try stream.addStreamOutput(handler, type: .audio, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream
        FileHandle.standardError.write(Data("READY\n".utf8))
    }
}

let capture = SystemAudioCapture()
Task {
    do { try await capture.start() }
    catch {
        FileHandle.standardError.write(Data("System audio unavailable: \(error.localizedDescription)\n".utf8))
        exit(1)
    }
}
RunLoop.main.run()