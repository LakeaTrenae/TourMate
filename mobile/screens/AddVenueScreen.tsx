/**
 * AddVenueScreen — create or edit a venue (`venueId` present = edit mode).
 * Venues aren't trigger-bearing (no completion-lock trigger — they're
 * org-scoped, not tour-scoped, so there's no tour completion status to
 * enforce against), so unlike almost every other write in this app, this
 * screen is free to chain `.select()` onto its writes without hitting the
 * RETURNING/RLS bug documented in lib/ids.ts.
 *
 * The "Locate" button resolves address/city/state into coordinates via
 * Open-Meteo's free, keyless geocoding endpoint (lib/geo.ts) — shown as a
 * confirmation line rather than raw editable lat/lng fields, since nobody
 * is going to type coordinates by hand. Weather (ShowDetailScreen) and
 * Route (RouteScreen) both silently skip any venue with no coordinates,
 * so geocoding is optional, not required to save.
 */
import { useCallback, useEffect, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { geocodeAddress } from '../lib/geo';
import { newId } from '../lib/ids';
import { parseOptionalNumber } from '../lib/numbers';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddVenue'>;

type Photo = { id: string; storage_path: string; url: string };

export function AddVenueScreen({ route, navigation }: Props) {
  const { organizationId, venueId } = route.params;
  const isEditing = !!venueId;
  const { session } = useAuth();

  const [loading, setLoading] = useState(isEditing);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [country, setCountry] = useState('');
  const [capacity, setCapacity] = useState('');
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  useEffect(() => {
    if (!venueId) return;
    supabase
      .from('venues')
      .select('name, address, city, state, country, capacity, latitude, longitude')
      .eq('id', venueId)
      .single()
      .then(({ data, error }) => {
        if (error) {
          setErrorMessage(error.message);
        } else if (data) {
          setName(data.name ?? '');
          setAddress(data.address ?? '');
          setCity(data.city ?? '');
          setState(data.state ?? '');
          setCountry(data.country ?? '');
          setCapacity(data.capacity ? String(data.capacity) : '');
          if (data.latitude != null && data.longitude != null) {
            setCoords({ latitude: data.latitude, longitude: data.longitude });
          }
        }
        setLoading(false);
      });
  }, [venueId]);

  async function loadPhotos() {
    if (!venueId) return;
    const { data, error } = await supabase
      .from('venue_photos')
      .select('id, storage_path')
      .eq('venue_id', venueId)
      .order('created_at', { ascending: true });
    if (error) {
      setErrorMessage(error.message);
      return;
    }

    // The bucket is private (org-gated, not public) — a plain public URL
    // wouldn't actually resolve, so each photo needs its own signed URL.
    // A 1-hour expiry, not the 5-minute one used for one-off document
    // opens elsewhere, since these render inline as a gallery someone
    // might sit looking at rather than a single "open and done" action.
    const withUrls = await Promise.all(
      (data ?? []).map(async (p) => {
        const { data: signed } = await supabase.storage.from('venue-photos').createSignedUrl(p.storage_path, 60 * 60);
        return { id: p.id, storage_path: p.storage_path, url: signed?.signedUrl ?? '' };
      })
    );
    setPhotos(withUrls.filter((p) => p.url));
  }

  useFocusEffect(
    useCallback(() => {
      loadPhotos();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [venueId])
  );

  async function handlePickPhoto() {
    if (!venueId || !session) return;
    setErrorMessage(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setErrorMessage('Photo library access is needed to add venue photos.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];

    setUploadingPhoto(true);
    try {
      const photoId = newId();
      const safeName = (asset.fileName ?? 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${organizationId}/${venueId}/${photoId}-${safeName}`;

      const response = await fetch(asset.uri);
      const fileData = await response.arrayBuffer();
      const { error: uploadError } = await supabase.storage
        .from('venue-photos')
        .upload(path, fileData, { contentType: asset.mimeType ?? 'image/jpeg' });
      if (uploadError) throw uploadError;

      // venue_photos has no trigger, so chaining .select() here is safe —
      // same non-trigger-bearing exception as the venue write itself.
      const { error: insertError } = await supabase
        .from('venue_photos')
        .insert({ id: photoId, venue_id: venueId, storage_path: path, uploaded_by: session.user.id });
      if (insertError) throw insertError;

      await loadPhotos();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to upload photo.');
    } finally {
      setUploadingPhoto(false);
    }
  }

  function confirmDeletePhoto(photo: Photo) {
    Alert.alert('Delete this photo?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('venue_photos').delete().eq('id', photo.id);
          if (error) {
            setErrorMessage(error.message);
            return;
          }
          // Best-effort — the metadata row (and thus visibility) is
          // already gone; a leftover storage object is just wasted space,
          // not a data-integrity or privacy issue.
          await supabase.storage.from('venue-photos').remove([photo.storage_path]);
          await loadPhotos();
        },
      },
    ]);
  }

  async function handleGeocode() {
    setErrorMessage(null);
    // Open-Meteo's geocoding API matches place names (cities, landmarks —
    // it's backed by GeoNames), not full street addresses, so a street
    // address in the query reliably returns zero results. City/state/
    // country gets city-center coordinates, not the exact building — good
    // enough for weather and route-distance estimates, which is all this
    // is used for.
    const query = [city, state, country].filter((s) => s.trim()).join(', ');
    if (!query.trim()) {
      setErrorMessage('Enter a city first.');
      return;
    }
    setGeocoding(true);
    const result = await geocodeAddress(query);
    setGeocoding(false);
    if (!result) {
      setErrorMessage("Couldn't locate that city — you can still save without it.");
      return;
    }
    setCoords(result);
  }

  async function handleSubmit() {
    setErrorMessage(null);
    if (!name.trim()) {
      setErrorMessage('Venue name is required.');
      return;
    }

    let parsedCapacity: number | null;
    try {
      parsedCapacity = parseOptionalNumber(capacity, 'capacity', 'int');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Invalid capacity.');
      return;
    }

    setSubmitting(true);
    const payload = {
      organization_id: organizationId,
      name: name.trim(),
      address: address.trim() || null,
      city: city.trim() || null,
      state: state.trim() || null,
      country: country.trim() || null,
      capacity: parsedCapacity,
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
      geocoded_at: coords ? new Date().toISOString() : null,
    };

    const { error } = isEditing
      ? await supabase.from('venues').update(payload).eq('id', venueId)
      : await supabase.from('venues').insert(payload);

    setSubmitting(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    navigation.goBack();
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{isEditing ? 'Edit Venue' : 'Add Venue'}</Text>

      <TextInput style={styles.input} placeholder="Venue name" placeholderTextColor="#6b6b76" value={name} onChangeText={setName} />
      <TextInput style={styles.input} placeholder="Address" placeholderTextColor="#6b6b76" value={address} onChangeText={setAddress} />
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="City" placeholderTextColor="#6b6b76" value={city} onChangeText={setCity} />
        <TextInput style={[styles.input, styles.rowInput]} placeholder="State" placeholderTextColor="#6b6b76" value={state} onChangeText={setState} />
      </View>
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Country" placeholderTextColor="#6b6b76" value={country} onChangeText={setCountry} />
        <TextInput
          style={[styles.input, styles.rowInput]}
          placeholder="Capacity"
          placeholderTextColor="#6b6b76"
          value={capacity}
          onChangeText={setCapacity}
          keyboardType="number-pad"
        />
      </View>

      <Pressable style={styles.geocodeButton} onPress={handleGeocode} disabled={geocoding}>
        {geocoding ? <ActivityIndicator color="#7c9cff" /> : <Text style={styles.geocodeButtonText}>Locate city (for weather & route)</Text>}
      </Pressable>
      {coords && (
        <Text style={styles.coordsText}>
          Located: {coords.latitude.toFixed(3)}, {coords.longitude.toFixed(3)} (city-level, not the exact address)
        </Text>
      )}

      {isEditing && (
        <>
          <Text style={styles.sectionTitle}>Stage & Venue Photos</Text>
          <Text style={styles.photosHint}>So the crew knows what the stage looks like before load-in.</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoRow} contentContainerStyle={styles.photoRowContent}>
            {photos.map((photo) => (
              <Pressable key={photo.id} onLongPress={() => confirmDeletePhoto(photo)}>
                <Image source={{ uri: photo.url }} style={styles.photoThumb} />
              </Pressable>
            ))}
            <Pressable style={styles.addPhotoButton} onPress={handlePickPhoto} disabled={uploadingPhoto}>
              {uploadingPhoto ? <ActivityIndicator color="#7c9cff" /> : <Text style={styles.addPhotoButtonText}>+ Photo</Text>}
            </Pressable>
          </ScrollView>
          {photos.length > 0 && <Text style={styles.photosHint}>Hold a photo to delete it.</Text>}
        </>
      )}

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>{isEditing ? 'Save Venue' : 'Add Venue'}</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 16 },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
    fontSize: 15,
  },
  row: { flexDirection: 'row', gap: 10 },
  rowInput: { flex: 1 },
  geocodeButton: {
    backgroundColor: '#1a1a20',
    borderWidth: 1,
    borderColor: '#2a2a32',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  geocodeButtonText: { color: '#7c9cff', fontSize: 14, fontWeight: '600' },
  coordsText: { color: '#6b6b76', fontSize: 12, textAlign: 'center', marginTop: 8 },
  sectionTitle: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginTop: 20, marginBottom: 4 },
  photosHint: { color: '#6b6b76', fontSize: 12, marginBottom: 8 },
  photoRow: { flexGrow: 0 },
  photoRowContent: { gap: 10, paddingRight: 8 },
  photoThumb: { width: 88, height: 88, borderRadius: 10, backgroundColor: '#1a1a20' },
  addPhotoButton: {
    width: 88,
    height: 88,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a2a32',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPhotoButtonText: { color: '#7c9cff', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  error: { color: '#ff6b6b', fontSize: 13, marginTop: 12 },
  submitButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  submitButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
});
