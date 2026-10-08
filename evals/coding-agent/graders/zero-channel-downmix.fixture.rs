// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use downmix_probe::audio_to_mono;
#[test]
fn zero_nonempty() {
    let x = [0.25, -0.5, 1.0];
    assert_eq!(audio_to_mono(&x, 0), x);
}
#[test]
fn zero_empty() {
    assert_eq!(audio_to_mono(&[], 0), Vec::<f32>::new());
}
#[test]
fn mono() {
    let x = [-1.0, 0.0, 0.25];
    assert_eq!(audio_to_mono(&x, 1), x);
}
#[test]
fn stereo() {
    assert_eq!(
        audio_to_mono(&[0.5, 1.0, -0.5, 0.25], 2),
        vec![0.75, -0.125]
    );
}
#[test]
fn four_channels() {
    assert_eq!(
        audio_to_mono(&[1.0, 0.0, -0.5, 0.5, 0.25, 0.25, 0.25, 0.25], 4),
        vec![0.25, 0.25]
    );
}
#[test]
fn real_silence() {
    assert_eq!(audio_to_mono(&[1.0, -1.0, 0.5, -0.5], 4), vec![0.0]);
}
#[test]
fn partial_frame() {
    assert_eq!(audio_to_mono(&[1.0, 1.0, 2.0], 2), vec![1.0, 1.0]);
}
#[test]
fn high_channels() {
    assert_eq!(audio_to_mono(&vec![0.5; 128], 64), vec![0.5, 0.5]);
}
#[test]
fn short_frame() {
    assert_eq!(audio_to_mono(&[1.0, 1.0], 8), vec![0.25]);
}
#[test]
fn empty_valid() {
    assert!(audio_to_mono(&[], 2).is_empty());
}
